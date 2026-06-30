import socket
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

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
                # We'll clean up disconnected clients later or let disconnect trigger

manager = ConnectionManager()

class NFCScanData(BaseModel):
    id: str
    techList: Optional[List[str]] = []
    payload: Optional[str] = ""
    cardType: Optional[str] = "Unknown"
    timestamp: Optional[str] = ""

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
            # Maintain connection and listen for heartbeat/messages if any
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket)

@app.post("/scan")
async def receive_scan(data: NFCScanData):
    print(f"\n[+] Received NFC Scan from phone:")
    print(f"    - Card ID: {data.id}")
    print(f"    - Card Type: {data.cardType}")
    print(f"    - Payload: {data.payload}")
    print(f"    - Tech List: {data.techList}")
    
    # Broadcast to all connected Web UI clients
    await manager.broadcast({
        "event": "nfc_scan",
        "data": data.dict()
    })
    
    return {"status": "success", "message": "NFC scan broadcasted"}

if __name__ == "__main__":
    import uvicorn
    local_ip = get_local_ip()
    print("=" * 60)
    print(f"Starting NFC Desktop Server...")
    print(f"Local Server URL: http://localhost:8000")
    print(f"Phone should connect to: http://{local_ip}:8000")
    print("=" * 60)
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
