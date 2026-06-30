import socket
import json
import base64
import io
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from typing import List, Optional
from PIL import Image

app = FastAPI()

# Setup templates directory
templates = Jinja2Templates(directory="templates")

def get_local_ip():
    """Get the local IP address of the computer on the network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't need to be reachable, just used to find local interface IP
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"New client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"Client disconnected. Total clients: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"Error sending to client: {e}")

manager = ConnectionManager()

# Data formats for inputs
class BiometricScanInput(BaseModel):
    dg1: str  # Base64 encoded DG1 file bytes
    dg2: Optional[str] = None  # Base64 encoded DG2 file bytes (image data)
    method: str  # CAN or MRZ
    timestamp: str

def parse_dg1(dg1_bytes: bytes) -> Optional[str]:
    """Parse the EF.DG1 file to extract the raw MRZ string."""
    try:
        # Search for tag 5F 1F which represents MRZ field in DG1 template
        idx = dg1_bytes.find(b'\x5f\x1f')
        if idx == -1:
            return None
        # In ASN.1 tag length value, next byte after 5F1F is the length
        length = dg1_bytes[idx + 2]
        # Next bytes are the MRZ text
        mrz_text = dg1_bytes[idx + 3 : idx + 3 + length].decode('ascii', errors='ignore')
        return mrz_text
    except Exception as e:
        print(f"Error decoding DG1 structure: {e}")
        return None

def format_mrz_date(date_str: str) -> str:
    """Format YYMMDD to YYYY-MM-DD."""
    if len(date_str) != 6 or not date_str.isdigit():
        return date_str
    yy = int(date_str[0:2])
    mm = date_str[2:4]
    dd = date_str[4:6]
    # Assuming pivot year 40 for century
    century = "20" if yy < 40 else "19"
    return f"{century}{yy:02d}-{mm}-{dd}"

def format_gender(gender_char: str) -> str:
    if gender_char == 'M': return "Male"
    if gender_char == 'F': return "Female"
    return "Unspecified"

def parse_mrz_text(mrz_text: str) -> dict:
    """Parse passport/ID card MRZ formats (TD1 and TD3)."""
    # Split text into lines and clean
    lines = [line.strip().upper() for line in mrz_text.replace('\r', '').split('\n') if line.strip()]
    if not lines:
        return {"raw": mrz_text}

    # If it's a single block, split it based on standard lengths
    if len(lines) == 1:
        if len(lines[0]) == 88:
            lines = [lines[0][:44], lines[0][44:]]
        elif len(lines[0]) == 90:
            lines = [lines[0][:30], lines[0][30:60], lines[0][60:]]
        else:
            return {"raw": mrz_text}

    try:
        if len(lines) == 2:  # Passport / TD3 2-line Format (44 characters each)
            line1, line2 = lines[0], lines[1]
            
            # Line 1 parsing
            doc_type = line1[0]
            country = line1[2:5].replace('<', '')
            name_part = line1[5:]
            names = [x for x in name_part.split('<<') if x]
            surname = names[0].replace('<', ' ').strip() if len(names) > 0 else ""
            given_names = names[1].replace('<', ' ').strip() if len(names) > 1 else ""
            
            # Line 2 parsing
            doc_num = line2[0:9].replace('<', '')
            nationality = line2[15:18].replace('<', '')
            dob = line2[18:24]
            gender = line2[28]
            expiry = line2[29:35]
            
            return {
                "documentType": "جواز سفر (Passport)" if doc_type == 'P' else "بطاقة هوية (ID Card)",
                "issuingCountry": country,
                "documentNumber": doc_num,
                "fullName": f"{given_names} {surname}".strip().title(),
                "nationality": nationality,
                "birthDate": format_mrz_date(dob),
                "gender": format_gender(gender),
                "expiryDate": format_mrz_date(expiry),
                "raw": mrz_text
            }
            
        elif len(lines) == 3:  # ID Card / TD1 3-line Format (30 characters each)
            line1, line2, line3 = lines[0], lines[1], lines[2]
            
            # Line 1 parsing
            doc_type = line1[0]
            country = line1[2:5].replace('<', '')
            doc_num = line1[5:14].replace('<', '')
            
            # Line 2 parsing
            dob = line2[0:6]
            gender = line2[7]
            expiry = line2[8:14]
            nationality = line2[15:18].replace('<', '')
            
            # Line 3 parsing
            names = [x for x in line3.split('<<') if x]
            surname = names[0].replace('<', ' ').strip() if len(names) > 0 else ""
            given_names = names[1].replace('<', ' ').strip() if len(names) > 1 else ""
            
            return {
                "documentType": "بطاقة هوية رسمية (National ID)",
                "issuingCountry": country,
                "documentNumber": doc_num,
                "fullName": f"{given_names} {surname}".strip().title(),
                "nationality": nationality,
                "birthDate": format_mrz_date(dob),
                "gender": format_gender(gender),
                "expiryDate": format_mrz_date(expiry),
                "raw": mrz_text
            }
    except Exception as e:
        print(f"Error parsing MRZ: {e}")
        
    return {"raw": mrz_text}

def extract_and_convert_face_image(dg2_bytes: bytes) -> tuple:
    """Extract face image from EF.DG2 file and convert JP2/J2K to standard Web-friendly PNG."""
    try:
        # Look for JPEG2000 JP2 file header
        jp2_idx = dg2_bytes.find(b'\x00\x00\x00\x0c\x6a\x50\x20\x20')
        img_bytes = None
        img_format = None
        
        if jp2_idx != -1:
            img_bytes = dg2_bytes[jp2_idx:]
            img_format = 'JP2'
        else:
            # Look for JPEG2000 J2K codestream header
            j2k_idx = dg2_bytes.find(b'\xff\x4f\xff\x51')
            if j2k_idx != -1:
                img_bytes = dg2_bytes[j2k_idx:]
                img_format = 'J2K'
            else:
                # Look for standard JPEG header
                jpeg_idx = dg2_bytes.find(b'\xff\xd8\xff')
                if jpeg_idx != -1:
                    img_bytes = dg2_bytes[jpeg_idx:]
                    img_format = 'JPEG'

        if not img_bytes:
            print("No matching image signature found in DG2.")
            return None, None

        # Convert JP2 / J2K to PNG using Pillow
        if img_format in ['JP2', 'J2K']:
            try:
                img = Image.open(io.BytesIO(img_bytes))
                out_buf = io.BytesIO()
                img.save(out_buf, format="PNG")
                base64_str = base64.b64encode(out_buf.getvalue()).decode('utf-8')
                return base64_str, "image/png"
            except Exception as e:
                print(f"Pillow JP2 decoding failed: {e}. Sending raw JP2 base64.")
                # Browser might not display it, but we send it as a fallback
                return base64.b64encode(img_bytes).decode('utf-8'), "image/jp2"
        else:
            # It's a standard JPEG, no conversion needed
            return base64.b64encode(img_bytes).decode('utf-8'), "image/jpeg"
            
    except Exception as e:
        print(f"Error extracting image: {e}")
        return None, None

@app.get("/", response_class=HTMLResponse)
async def get_dashboard(request: Request):
    local_ip = get_local_ip()
    return templates.TemplateResponse("index.html", {
        "request": request, 
        "local_ip": local_ip,
        "port": 8000
    })

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket)

@app.post("/scan")
async def receive_scan(input_data: BiometricScanInput):
    print(f"\n[+] Received Biometric Card Scan via {input_data.method}:")
    
    # 1. Parse DG1 to get MRZ
    try:
        dg1_bytes = base64.b64decode(input_data.dg1)
        mrz_text = parse_dg1(dg1_bytes)
        if mrz_text:
            print(f"    - Extracted MRZ: {mrz_text.replace(chr(10), ' | ')}")
            parsed_info = parse_mrz_text(mrz_text)
        else:
            print("    - Failed to extract MRZ string from DG1")
            parsed_info = {"raw": "Failed to decode DG1"}
    except Exception as e:
        print(f"    - Error parsing DG1: {e}")
        parsed_info = {"raw": f"Error: {e}"}

    # 2. Extract Photo from DG2
    photo_base64 = None
    photo_mime = None
    if input_data.dg2:
        try:
            dg2_bytes = base64.b64decode(input_data.dg2)
            photo_base64, photo_mime = extract_and_convert_face_image(dg2_bytes)
            if photo_base64:
                print(f"    - Successfully extracted face image ({photo_mime})")
            else:
                print("    - Failed to extract face image from DG2")
        except Exception as e:
            print(f"    - Error extracting image from DG2: {e}")

    # Build Broadcast Message
    broadcast_data = {
        "event": "biometric_scan",
        "data": {
            "method": input_data.method,
            "info": parsed_info,
            "photo": photo_base64,
            "photoMime": photo_mime,
            "timestamp": input_data.timestamp
        }
    }

    # Broadcast to all connected Web UI clients
    await manager.broadcast(broadcast_data)
    
    return {"status": "success", "message": "Biometric card read processed successfully"}

if __name__ == "__main__":
    import uvicorn
    local_ip = get_local_ip()
    print("=" * 60)
    print(f"Starting Biometric NFC Desktop Server...")
    print(f"Local Server URL: http://localhost:8000")
    print(f"Phone should connect to: http://{local_ip}:8000")
    print("=" * 60)
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
