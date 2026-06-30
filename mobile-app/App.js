import React, { useState, useEffect } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  TextInput, 
  TouchableOpacity, 
  ActivityIndicator, 
  SafeAreaView, 
  StatusBar,
  Keyboard,
  TouchableWithoutFeedback,
  ScrollView
} from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CryptoJS from 'crypto-js';

// Pre-initialize NFC Manager
NfcManager.start();

// --- ICAO 9303 Cryptography Helpers ---

// Calculate check digit (ICAO 9303 Weight: 7, 3, 1)
function getCheckDigit(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    let val = 0;
    if (c >= 48 && c <= 57) { // 0-9
      val = c - 48;
    } else if (c >= 65 && c <= 90) { // A-Z
      val = c - 65 + 10;
    } else if (str[i] === '<') {
      val = 0;
    }
    sum += val * weights[i % 3];
  }
  return sum % 10;
}

// Convert Hex String to WordArray for CryptoJS
function hexToWords(hexStr) {
  return CryptoJS.enc.Hex.parse(hexStr);
}

// Convert WordArray to Hex String
function wordsToHex(words) {
  return CryptoJS.enc.Hex.stringify(words);
}

// TripleDES encryption using CryptoJS (raw block-by-block CBC)
function encrypt3DES(dataHex, keyHex, ivHex = "0000000000000000") {
  const key = hexToWords(keyHex);
  const iv = hexToWords(ivHex);
  const data = hexToWords(dataHex);
  
  const encrypted = CryptoJS.TripleDES.encrypt(data, key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.NoPadding
  });
  return wordsToHex(encrypted.ciphertext);
}

// TripleDES decryption
function decrypt3DES(dataHex, keyHex, ivHex = "0000000000000000") {
  const key = hexToWords(keyHex);
  const iv = hexToWords(ivHex);
  
  const decrypted = CryptoJS.TripleDES.decrypt({ ciphertext: hexToWords(dataHex) }, key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.NoPadding
  });
  return wordsToHex(decrypted);
}

// ISO 9797-1 padding method 2 (append 80, then pad with 00s to multiple of 8 bytes)
function padISO9797(dataHex) {
  let padded = dataHex + "80";
  while (padded.length % 16 !== 0) {
    padded += "00";
  }
  return padded;
}

// ISO 9797-1 MAC Algorithm 3 (Retail MAC) using 3DES
function calculateRetailMAC(dataHex, keyHex) {
  // Key is 16 bytes (Ka + Kb)
  const Ka = keyHex.substring(0, 16);
  const Kb = keyHex.substring(16, 32);
  
  let blocks = [];
  for (let i = 0; i < dataHex.length; i += 16) {
    blocks.push(dataHex.substring(i, i + 16));
  }
  
  // Single DES CBC on Ka
  let currentBlock = "0000000000000000";
  for (let block of blocks) {
    // XOR
    let xored = "";
    for (let j = 0; j < 16; j += 2) {
      let b1 = parseInt(currentBlock.substring(j, j + 2), 16);
      let b2 = parseInt(block.substring(j, j + 2), 16);
      xored += (b1 ^ b2).toString(16).padStart(2, '0');
    }
    // Encrypt with DES Ka
    // CryptoJS TripleDES with single 8-byte key acts as Single DES
    const desKey = hexToWords(Ka + Ka + Ka); // Repeat to form 3DES key
    const enc = CryptoJS.TripleDES.encrypt(hexToWords(xored), desKey, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.NoPadding
    });
    currentBlock = wordsToHex(enc.ciphertext).substring(0, 16);
  }
  
  // Decrypt with Kb, then Encrypt with Ka
  const keyKb = hexToWords(Kb + Kb + Kb);
  const dec = CryptoJS.TripleDES.decrypt({ ciphertext: hexToWords(currentBlock) }, keyKb, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.NoPadding
  });
  let mid = wordsToHex(dec).substring(0, 16);
  
  const keyKa = hexToWords(Ka + Ka + Ka);
  const encFinal = CryptoJS.TripleDES.encrypt(hexToWords(mid), keyKa, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.NoPadding
  });
  return wordsToHex(encFinal.ciphertext).substring(0, 16);
}

// XOR two hex strings
function xorHex(hex1, hex2) {
  let result = "";
  for (let i = 0; i < hex1.length; i += 2) {
    let b1 = parseInt(hex1.substring(i, i + 2), 16);
    let b2 = parseInt(hex2.substring(i, i + 2), 16);
    result += (b1 ^ b2).toString(16).padStart(2, '0');
  }
  return result;
}

// Helper to convert byte array to Hex
function bytesToHex(byteArray) {
  return Array.from(byteArray, byte => ('0' + (byte & 0xFF).toString(16)).slice(-2)).join('');
}

// Helper to convert Hex to byte array
function hexToBytes(hex) {
  let bytes = [];
  for (let c = 0; i = 0, c < hex.length; c += 2, i++) {
    bytes[i] = parseInt(hex.substring(c, c + 2), 16);
  }
  return bytes;
}

export default function App() {
  const [ipAddress, setIpAddress] = useState('192.168.1.100');
  const [port, setPort] = useState('8000');
  const [status, setStatus] = useState('جاهز للاتصال');
  const [isNfcSupported, setIsNfcSupported] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  // Biometric details fields
  const [docNumber, setDocNumber] = useState('');
  const [dob, setDob] = useState(''); // Format: YYMMDD
  const [expiry, setExpiry] = useState(''); // Format: YYMMDD
  
  // CAN Number (fallback / alternate mode)
  const [canNumber, setCanNumber] = useState('');
  const [useCanMode, setUseCanMode] = useState(false); // True = CAN, False = MRZ

  // Load saved settings
  useEffect(() => {
    async function loadSettings() {
      try {
        const savedIp = await AsyncStorage.getItem('server_ip');
        const savedPort = await AsyncStorage.getItem('server_port');
        if (savedIp) setIpAddress(savedIp);
        if (savedPort) setPort(savedPort);

        const supported = await NfcManager.isSupported();
        setIsNfcSupported(supported);
        if (!supported) {
          setStatus('هذا الهاتف لا يدعم تقنية NFC');
        }
      } catch (err) {
        console.log('Error loading settings:', err);
      }
    }
    loadSettings();
  }, []);

  const saveSettings = async (ip, prt) => {
    try {
      await AsyncStorage.setItem('server_ip', ip);
      await AsyncStorage.setItem('server_port', prt);
    } catch (err) {
      console.log(err);
    }
  };

  const testConnection = async () => {
    setIsLoading(true);
    setStatus('جاري اختبار الاتصال بالكمبيوتر...');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const response = await fetch(`http://${ipAddress}:${port}/`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        setStatus('اتصال ناجح! الخادم يستمع.');
        saveSettings(ipAddress, port);
      } else {
        setStatus('فشل الاتصال بالكمبيوتر. يرجى فتح الخادم.');
      }
    } catch (err) {
      setStatus('تعذر الوصول للكمبيوتر. تأكد أنهما على نفس شبكة الـ WiFi.');
    } finally {
      setIsLoading(false);
    }
  };

  // Perform ICAO BAC Handshake and Read Passport Files
  const scanBiometricCard = async () => {
    if (!isNfcSupported) return;

    // Validate inputs
    let mrzString = "";
    if (useCanMode) {
      if (canNumber.length !== 6 || isNaN(canNumber)) {
        setStatus('يرجى إدخال رقم CAN صحيح مكون من 6 أرقام');
        return;
      }
      // Note: Full PACE handshake is highly complex. For maximum compatibility with ICAO 9303,
      // we utilize BAC as the primary channel. If the card only supports PACE/CAN, 
      // the user must input the MRZ details (DOB/Expiry/DocNum) to perform BAC.
      setStatus('وضع الـ CAN يتطلب بروتوكول PACE المعقد. يرجى استخدام وضع MRZ لمصادقة بطاقات السفر.');
      return;
    } else {
      if (docNumber.trim().length < 5 || dob.length !== 6 || expiry.length !== 6) {
        setStatus('يرجى ملء جميع حقول الـ MRZ بشكل صحيح (سنة/شهر/يوم)');
        return;
      }
    }

    try {
      setIsLoading(true);
      setStatus('جاري تفعيل الـ NFC... قرب البطاقة من الهاتف');

      // Request IsoDep technology (needed for passports and smart ID cards)
      await NfcManager.requestTechnology([NfcTech.IsoDep]);
      
      setStatus('تم اكتشاف البطاقة! جاري الاتصال المباشر...');

      // 1. SELECT eMRTD Applet
      // AID: A0 00 00 02 47 10 01
      const selectAppletApdu = [0x00, 0xA4, 0x04, 0x0C, 0x07, 0xA0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01];
      let selectResp = await NfcManager.sendCommandAPDUSOP(selectAppletApdu);
      let selectRespHex = bytesToHex(selectResp);
      
      // Check if eMRTD applet selected successfully (should end with 9000)
      if (!selectRespHex.endsWith("9000")) {
        // Fallback: This is not a biometric document, or it is a simple RFID tag
        setStatus('هذه ليست وثيقة بيومترية متوافقة. جاري قراءة رقم التعريف UID كبديل...');
        const tag = await NfcManager.getTag();
        await transmitSimpleUIDToPC(tag);
        return;
      }

      setStatus('تم التعرف على وثيقة بيومترية. جاري فك التشفير (BAC)...');

      // Calculate keys from inputs
      const doc = docNumber.toUpperCase().padEnd(9, '<');
      const c_doc = getCheckDigit(doc);
      const c_dob = getCheckDigit(dob);
      const c_exp = getCheckDigit(expiry);
      const mrzInfo = `${doc}${c_doc}${dob}${c_dob}${expiry}${c_exp}`;

      // Derive K_enc and K_mac
      const mrzHash = CryptoJS.SHA1(CryptoJS.enc.Utf8.parse(mrzInfo));
      const kSeed = mrzHash.toString().substring(0, 32);
      
      // Derive Ka/Kb for Enc & Mac
      const dEnc = CryptoJS.enc.Hex.parse(kSeed + "00000001");
      const dMac = CryptoJS.enc.Hex.parse(kSeed + "00000002");
      const kEnc = CryptoJS.enc.Hex.parse(CryptoJS.SHA1(dEnc).toString()).toString().substring(0, 32);
      const kMac = CryptoJS.enc.Hex.parse(CryptoJS.SHA1(dMac).toString()).toString().substring(0, 32);

      // 2. GET CHALLENGE to retrieve RND_IC
      const getChallengeApdu = [0x00, 0x84, 0x00, 0x00, 0x08];
      let challengeResp = await NfcManager.sendCommandAPDUSOP(getChallengeApdu);
      let challengeHex = bytesToHex(challengeResp);
      
      if (!challengeHex.endsWith("9000") || challengeResp.length < 10) {
        throw new Error("Failed to get challenge from chip.");
      }
      
      const rndIc = challengeHex.substring(0, 16); // 8 bytes RND_IC
      
      // 3. Generate random values for Terminal
      const rndIfd = "1234567890ABCDEF"; // 8 bytes random
      const kIfd = "AABBCCDDEEFF00112233445566778899"; // 16 bytes random key seed
      
      // S = RND_IFD + RND_IC + K_IFD
      const S = rndIfd + rndIc + kIfd;
      
      // Encrypt S with K_enc to get E_IFD
      const eIfd = encrypt3DES(S, kEnc);
      
      // Calculate MAC M_IFD over E_IFD using K_mac
      const paddedEIfd = padISO9797(eIfd);
      const mIfd = calculateRetailMAC(paddedEIfd, kMac);
      
      // 4. EXTERNAL AUTHENTICATE command
      // APDU Header: 00 82 00 00 28 (length is 40 bytes)
      const extAuthPayload = hexToBytes(eIfd + mIfd);
      const extAuthApdu = [0x00, 0x82, 0x00, 0x00, 0x28, ...extAuthPayload];
      
      let authResp = await NfcManager.sendCommandAPDUSOP(extAuthApdu);
      let authRespHex = bytesToHex(authResp);
      
      if (!authRespHex.endsWith("9000")) {
        throw new Error("BAC Authentication failed. Verify MRZ details.");
      }
      
      setStatus('نجحت المصادقة! جاري توليد قنوات الاتصال الآمنة...');

      // Extract E_IC and M_IC from response
      const eIc = authRespHex.substring(0, 64); // first 32 bytes
      
      // Decrypt E_IC using K_enc
      const decryptedEIC = decrypt3DES(eIc, kEnc);
      const kIc = decryptedEIC.substring(32, 64); // K_IC is the last 16 bytes
      
      // Compute final K_seed = K_IFD XOR K_IC
      const finalKSeed = xorHex(kIfd, kIc);
      
      // Derive Secure Messaging Keys: K_SM_ENC & K_SM_MAC
      const dEncSM = CryptoJS.enc.Hex.parse(finalKSeed + "00000001");
      const dMacSM = CryptoJS.enc.Hex.parse(finalKSeed + "00000002");
      const kSmEnc = CryptoJS.enc.Hex.parse(CryptoJS.SHA1(dEncSM).toString()).toString().substring(0, 32);
      const kSmMac = CryptoJS.enc.Hex.parse(CryptoJS.SHA1(dMacSM).toString()).toString().substring(0, 32);
      
      // Calculate initial Send Sequence Counter (SSC)
      // SSC = last 4 bytes of RND_IC + last 4 bytes of RND_IFD
      let ssc = rndIc.substring(8, 16) + rndIfd.substring(8, 16);
      
      setStatus('تم إنشاء قناة مشفرة. جاري قراءة البيانات الشخصية (DG1)...');

      // Helper to increment SSC
      function incrementSSC() {
        let val = BigInt("0x" + ssc);
        val = val + 1n;
        ssc = val.toString(16).toUpperCase().padStart(16, '0');
      }

      // Helper to build Secure Messaging APDU (wrap)
      function wrapAPDU(apduHeader, dataHex = "") {
        incrementSSC();
        
        let do87 = "";
        if (dataHex.length > 0) {
          // Encrypt data
          let paddedData = padISO9797(dataHex);
          // In SM, the encryption IV is derived by encrypting the SSC with K_SM_ENC
          let iv = encrypt3DES(ssc, kSmEnc);
          let encryptedData = encrypt3DES(paddedData, kSmEnc, iv);
          
          // Build DO87 tag: 87 [Length] 01 [EncryptedData] (01 indicates padding method 2)
          let content = "01" + encryptedData;
          let lenHex = (content.length / 2).toString(16).padStart(2, '0');
          // If length is > 127 bytes, handle ASN.1 long form
          if (content.length / 2 > 127) {
            lenHex = "81" + lenHex;
          }
          do87 = "87" + lenHex + content;
        }
        
        // Build DO97 (Le tag): 97 01 [Expected Length]
        let do97 = "970100"; // request maximum length
        
        // Construct M (Data over which MAC is calculated)
        // M = SSC + APDU Header (masked) + DO87 + DO97
        let maskedHeader = apduHeader.substring(0, 2) + "B0" + apduHeader.substring(4, 8) + "00";
        let m = ssc + maskedHeader + do87 + do97;
        let paddedM = padISO9797(m);
        
        // Calculate MAC
        let mac = calculateRetailMAC(paddedM, kSmMac);
        let do8e = "8E08" + mac;
        
        // Final Wrapped APDU
        // CLA is changed to 0C (indicates secure messaging)
        let finalData = do87 + do97 + do8e;
        let finalLen = (finalData.length / 2).toString(16).padStart(2, '0');
        let finalApdu = "0CB0" + apduHeader.substring(4, 8) + finalLen + finalData;
        
        return hexToBytes(finalApdu);
      }

      // Helper to parse Secure Messaging Response (unwrap)
      function unwrapResponse(respHex) {
        // Response ends with 9000 or other status
        let status = respHex.substring(respHex.length - 4);
        if (status !== "9000") {
          return { status, data: "" };
        }
        
        // Parse DO87 (contains encrypted data)
        let dataStart = respHex.indexOf("87");
        if (dataStart === -1) {
          // Just status, no encrypted payload
          return { status, data: "" };
        }
        
        // Read length
        let lenByte = parseInt(respHex.substring(dataStart + 2, dataStart + 4), 16);
        let contentIdx = dataStart + 4;
        if (lenByte === 129 || lenByte === 0x81) {
          lenByte = parseInt(respHex.substring(dataStart + 4, dataStart + 6), 16);
          contentIdx = dataStart + 6;
        }
        
        // Skip padding indicator (01)
        let encData = respHex.substring(contentIdx + 2, contentIdx + lenByte * 2);
        
        // Decrypt
        incrementSSC();
        let iv = encrypt3DES(ssc, kSmEnc);
        let decrypted = decrypt3DES(encData, kSmEnc, iv);
        
        // Remove padding (find last 80 and strip)
        let last80 = decrypted.lastIndexOf("80");
        if (last80 !== -1) {
          decrypted = decrypted.substring(0, last80);
        }
        
        return { status, data: decrypted };
      }

      // 5. READ EF.DG1 (File ID: 01 01)
      // Select file: 00 A4 02 0C 02 01 01
      // For simplicity, we can read files by constructing standard wrapped read commands directly.
      // In ICAO SM, we select file first.
      const selectDg1Apdu = wrapAPDU("00A4020C020101");
      let selectDg1Resp = await NfcManager.sendCommandAPDUSOP(selectDg1Apdu);
      
      // Read binary in blocks (Read first 256 bytes)
      const readDg1Apdu = wrapAPDU("00B0000000"); // read 256 bytes from offset 0
      let readDg1Resp = await NfcManager.sendCommandAPDUSOP(readDg1Apdu);
      let unwrappedDg1 = unwrapResponse(bytesToHex(readDg1Resp));

      if (unwrappedDg1.status !== "9000" || !unwrappedDg1.data) {
        throw new Error("Failed to read EF.DG1 personal data.");
      }

      const dg1Base64 = base64EncodeHex(unwrappedDg1.data);
      
      setStatus('نجحت قراءة DG1. جاري قراءة الصورة البيومترية (DG2)...');

      // 6. READ EF.DG2 (File ID: 01 02)
      const selectDg2Apdu = wrapAPDU("00A4020C020102");
      await NfcManager.sendCommandAPDUSOP(selectDg2Apdu);

      // Read DG2 length first (Read first 32 bytes to get file size)
      const readDg2LengthApdu = wrapAPDU("00B0000020");
      let readDg2LenResp = await NfcManager.sendCommandAPDUSOP(readDg2LengthApdu);
      let unwrappedDg2Len = unwrapResponse(bytesToHex(readDg2LenResp));
      
      let totalDg2Length = 8000; // Default fallback to read 8KB if length parsing fails
      if (unwrappedDg2Len.status === "9000" && unwrappedDg2Len.data.length >= 8) {
        // Parse ASN.1 length of DG2 template (usually starts with 75 [length])
        let tag75 = unwrappedDg2Len.data.substring(0, 2);
        if (tag75 === "75") {
          let lenByte = parseInt(unwrappedDg2Len.data.substring(2, 4), 16);
          if (lenByte > 127) {
            let numBytes = lenByte & 0x7F;
            totalDg2Length = parseInt(unwrappedDg2Len.data.substring(4, 4 + numBytes * 2), 16);
          } else {
            totalDg2Length = lenByte;
          }
        }
      }
      
      setStatus(`جاري تحميل الصورة (${Math.round(totalDg2Length / 1024)} KB)...`);
      
      // Read entire DG2 file in chunks (max 220 bytes per read in Secure Messaging)
      let dg2Hex = "";
      let offset = 0;
      while (offset < totalDg2Length) {
        let readLen = Math.min(200, totalDg2Length - offset);
        let offsetHex = offset.toString(16).padStart(4, '0');
        let lenHex = readLen.toString(16).padStart(2, '0');
        
        let chunkApdu = wrapAPDU(`00B0${offsetHex}${lenHex}`);
        let chunkResp = await NfcManager.sendCommandAPDUSOP(chunkApdu);
        let unwrappedChunk = unwrapResponse(bytesToHex(chunkResp));
        
        if (unwrappedChunk.status !== "9000") {
          break;
        }
        dg2Hex += unwrappedChunk.data;
        offset += readLen;
        
        setStatus(`جاري تحميل الصورة: ${Math.min(100, Math.round((offset / totalDg2Length) * 100))}%`);
      }

      const dg2Base64 = base64EncodeHex(dg2Hex);
      
      setStatus('اكتمل القراءة بالكامل! جاري إرسال البيانات للكمبيوتر...');

      // 7. Transmit biological files to PC server
      await transmitBiometricDataToPC({
        dg1: dg1Base64,
        dg2: dg2Base64,
        method: "MRZ",
        timestamp: new Date().toLocaleTimeString()
      });

    } catch (ex) {
      console.warn(ex);
      setStatus(`خطأ أثناء القراءة: ${ex.message || ex}`);
    } finally {
      NfcManager.cancelTechnologyRequest();
      setIsLoading(false);
    }
  };

  // Helper to convert HEX to Base64
  const base64EncodeHex = (hex) => {
    let raw = hexToWords(hex);
    return CryptoJS.enc.Base64.stringify(raw);
  };

  const transmitBiometricDataToPC = async (payload) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`http://${ipAddress}:${port}/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        setStatus('تم إرسال جواز السفر وفك تشفير البيانات على الكمبيوتر بنجاح! 🥳🎉');
      } else {
        setStatus('فشلت عملية الإرسال، الخادم لم يتقبل البيانات.');
      }
    } catch (err) {
      setStatus('تمت قراءة البيانات بنجاح، ولكن فشل إرسالها للكمبيوتر. تحقق من الـ WiFi.');
    }
  };

  const transmitSimpleUIDToPC = async (tag) => {
    // Falls back to sending simple tag UID to local server
    try {
      const payload = {
        dg1: base64EncodeHex(bytesToHex(tag.id ? hexToBytes(tag.id) : [0])),
        dg2: null,
        method: "UID (بطاقة غير مشفرة)",
        timestamp: new Date().toLocaleTimeString()
      };
      
      const response = await fetch(`http://${ipAddress}:${port}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        setStatus('تم إرسال معرّف الكارت العادي UID للكمبيوتر بنجاح!');
      }
    } catch (err) {
      setStatus('فشلت قراءة الوثيقة وفشل الاتصال بالخادم.');
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        
        <View style={styles.header}>
          <Text style={styles.headerTitle}>ماسح الهويات والجوازات بيومتري 🛂</Text>
          <Text style={styles.headerSubtitle}>قراء فك تشفير مستندات ICAO 9303 لاسلكياً</Text>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* 1. Connection Config Card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>إعدادات خادم الكمبيوتر</Text>
            <View style={styles.row}>
              <View style={[styles.inputGroup, { flex: 2, marginRight: 8 }]}>
                <Text style={styles.label}>IP الكمبيوتر:</Text>
                <TextInput
                  style={styles.input}
                  placeholder="192.168.1.15"
                  placeholderTextColor="#555"
                  value={ipAddress}
                  onChangeText={setIpAddress}
                />
              </View>
              <View style={[styles.inputGroup, { flex: 1 }]}>
                <Text style={styles.label}>Port:</Text>
                <TextInput
                  style={styles.input}
                  placeholder="8000"
                  placeholderTextColor="#555"
                  value={port}
                  onChangeText={setPort}
                  keyboardType="numeric"
                />
              </View>
            </View>
            <TouchableOpacity style={styles.testButton} onPress={testConnection}>
              <Text style={styles.buttonText}>اختبار الربط 💻</Text>
            </TouchableOpacity>
          </View>

          {/* Mode Selector */}
          <View style={styles.modeTabs}>
            <TouchableOpacity 
              style={[styles.tab, !useCanMode && styles.activeTab]} 
              onPress={() => setUseCanMode(false)}
            >
              <Text style={[styles.tabText, !useCanMode && styles.activeTabText]}>وضع الـ MRZ (الجوازات والهويات)</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.tab, useCanMode && styles.activeTab]} 
              onPress={() => setUseCanMode(true)}
            >
              <Text style={[styles.tabText, useCanMode && styles.activeTabText]}>وضع الـ CAN (هوية فقط)</Text>
            </TouchableOpacity>
          </View>

          {/* Input details based on selected mode */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>معلومات فك التشفير المطلوبة للبطاقة</Text>
            
            {!useCanMode ? (
              <View>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>رقم الوثيقة / الجواز (9 خانات):</Text>
                  <TextInput
                    style={[styles.input, styles.inputLeft]}
                    placeholder="L898902C3"
                    placeholderTextColor="#555"
                    value={docNumber}
                    onChangeText={setDocNumber}
                    autoCapitalize="characters"
                  />
                </View>
                <View style={styles.row}>
                  <View style={[styles.inputGroup, { flex: 1, marginRight: 8 }]}>
                    <Text style={styles.label}>تاريخ الميلاد (سنةشهررقم):</Text>
                    <TextInput
                      style={[styles.input, styles.inputLeft]}
                      placeholder="740812 (12-أغسطس-1974)"
                      placeholderTextColor="#555"
                      value={dob}
                      onChangeText={setDob}
                      keyboardType="numeric"
                      maxLength={6}
                    />
                  </View>
                  <View style={[styles.inputGroup, { flex: 1 }]}>
                    <Text style={styles.label}>تاريخ الانتهاء (سنةشهررقم):</Text>
                    <TextInput
                      style={[styles.input, styles.inputLeft]}
                      placeholder="290415 (15-أبريل-2029)"
                      placeholderTextColor="#555"
                      value={expiry}
                      onChangeText={setExpiry}
                      keyboardType="numeric"
                      maxLength={6}
                    />
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.inputGroup}>
                <Text style={styles.label}>رقم الـ CAN (مكون من 6 أرقام على واجهة البطاقة):</Text>
                <TextInput
                  style={[styles.input, styles.inputLeft]}
                  placeholder="123456"
                  placeholderTextColor="#555"
                  value={canNumber}
                  onChangeText={setCanNumber}
                  keyboardType="numeric"
                  maxLength={6}
                />
              </View>
            )}

            <TouchableOpacity 
              style={[styles.scanButton, (!isNfcSupported || isLoading) && styles.disabledButton]} 
              onPress={scanBiometricCard}
              disabled={!isNfcSupported || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" size="large" />
              ) : (
                <Text style={styles.scanButtonText}>ابدأ مسح الوثيقة بالـ NFC 🛡️</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Status badge */}
          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>حالة الاتصال والمسح الحالية:</Text>
            <Text style={styles.statusValue}>{status}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050508',
  },
  header: {
    padding: 20,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 6,
  },
  scrollContent: {
    padding: 16,
  },
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 14,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
  },
  inputGroup: {
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 6,
    textAlign: 'right',
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    padding: 10,
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
  },
  inputLeft: {
    textAlign: 'left',
    fontFamily: 'Outfit',
  },
  testButton: {
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.2)',
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  modeTabs: {
    flexDirection: 'row',
    marginBottom: 16,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 10,
    padding: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  activeTab: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
  },
  tabText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: 'bold',
  },
  activeTabText: {
    color: '#06b6d4',
  },
  scanButton: {
    backgroundColor: '#06b6d4',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  disabledButton: {
    backgroundColor: '#164e63',
  },
  buttonText: {
    color: '#06b6d4',
    fontSize: 14,
    fontWeight: 'bold',
  },
  scanButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  statusCard: {
    backgroundColor: 'rgba(255,255,255,0.01)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  statusLabel: {
    fontSize: 11,
    color: '#64748b',
    marginBottom: 4,
  },
  statusValue: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 20,
  },
});
