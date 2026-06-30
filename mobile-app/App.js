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
  TouchableWithoutFeedback
} from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Pre-initialize NFC Manager
NfcManager.start();

export default function App() {
  const [ipAddress, setIpAddress] = useState('192.168.1.100');
  const [port, setPort] = useState('8000');
  const [isNfcSupported, setIsNfcSupported] = useState(true);
  const [status, setStatus] = useState('جاهز للاتصال');
  const [scannedId, setScannedId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load saved IP address on start
  useEffect(() => {
    async function loadSettings() {
      try {
        const savedIp = await AsyncStorage.getItem('server_ip');
        const savedPort = await AsyncStorage.getItem('server_port');
        if (savedIp) setIpAddress(savedIp);
        if (savedPort) setPort(savedPort);

        // Check if NFC is supported
        const supported = await NfcManager.isSupported();
        setIsNfcSupported(supported);
        if (!supported) {
          setStatus('هذا الجهاز لا يدعم تقنية NFC');
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
      console.log('Error saving settings:', err);
    }
  };

  const testConnection = async () => {
    setIsLoading(true);
    setStatus('جاري اختبار الاتصال بالكمبيوتر...');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 sec timeout

      const response = await fetch(`http://${ipAddress}:${port}/`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        setStatus('اتصال ناجح! الكمبيوتر متصل.');
        saveSettings(ipAddress, port);
      } else {
        setStatus('فشل الاتصال بالكمبيوتر. يرجى التحقق من الخادم.');
      }
    } catch (err) {
      console.log(err);
      setStatus('تعذر الوصول للكمبيوتر. تأكد أنهما على نفس الـ WiFi.');
    } finally {
      setIsLoading(false);
    }
  };

  const scanNfcCard = async () => {
    if (!isNfcSupported) {
      setStatus('الجهاز لا يدعم NFC');
      return;
    }

    try {
      setScannedId(null);
      setStatus('قرب البطاقة من خلف الهاتف الآن...');
      setIsLoading(true);

      // Request NfcA technology to read UID of any standard RFID card
      await NfcManager.requestTechnology([NfcTech.NfcA]);
      const tag = await NfcManager.getTag();
      
      if (tag && tag.id) {
        const cardId = tag.id;
        setScannedId(cardId);
        setStatus(`تمت القراءة بنجاح ID: ${cardId}\nجاري الإرسال للكمبيوتر...`);
        
        await transmitDataToPC(tag);
      } else {
        setStatus('فشل قراءة معرّف البطاقة.');
      }
    } catch (ex) {
      console.warn(ex);
      setStatus('تم إلغاء عملية القراءة أو حدوث خطأ.');
    } finally {
      // Release NFC hardware
      NfcManager.cancelTechnologyRequest();
      setIsLoading(false);
    }
  };

  const transmitDataToPC = async (tag) => {
    try {
      // Prepare payload if any NDEF records are available
      let decodedPayload = "";
      if (tag.ndefMessage && tag.ndefMessage.length > 0) {
        // Simple helper to decode text payloads
        try {
          const record = tag.ndefMessage[0];
          // NDEF payloads usually contain language code prefix
          const payloadBytes = record.payload;
          decodedPayload = String.fromCharCode.apply(null, payloadBytes);
        } catch (e) {
          decodedPayload = "Non-text or binary payload";
        }
      }

      const bodyData = {
        id: tag.id,
        techList: tag.techTypes || [],
        payload: decodedPayload,
        cardType: tag.type || "NFC Tag",
        timestamp: new Date().toLocaleTimeString()
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 sec timeout

      const response = await fetch(`http://${ipAddress}:${port}/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyData),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        setStatus('تم إرسال بيانات البطاقة للكمبيوتر بنجاح! 🎉');
      } else {
        setStatus('تمت القراءة، ولكن الخادم رفض استلام البيانات.');
      }
    } catch (err) {
      console.log(err);
      setStatus('تمت القراءة، لكن فشل الإرسال للكمبيوتر. تحقق من الـ WiFi.');
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        
        <View style={styles.header}>
          <Text style={styles.headerTitle}>مرسل بطاقات NFC 📡</Text>
          <Text style={styles.headerSubtitle}>إرسال بيانات الهوية للكمبيوتر لاسلكياً</Text>
        </View>

        <View style={styles.content}>
          {/* Connection settings card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>إعدادات الاتصال بالكمبيوتر</Text>
            
            <View style={styles.inputGroup}>
              <Text style={styles.label}>عنوان IP للكمبيوتر:</Text>
              <TextInput
                style={styles.input}
                placeholder="192.168.1.5"
                placeholderTextColor="#666"
                value={ipAddress}
                onChangeText={setIpAddress}
                keyboardType="numeric"
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>المنفذ (Port):</Text>
              <TextInput
                style={styles.input}
                placeholder="8000"
                placeholderTextColor="#666"
                value={port}
                onChangeText={setPort}
                keyboardType="numeric"
              />
            </View>

            <TouchableOpacity 
              style={styles.testButton} 
              onPress={testConnection}
              disabled={isLoading}
            >
              <Text style={styles.buttonText}>اختبار الاتصال 💻</Text>
            </TouchableOpacity>
          </View>

          {/* Scanner Activation Area */}
          <View style={[styles.card, styles.scanCard]}>
            <Text style={styles.cardTitle}>ماسح بطاقات NFC</Text>
            
            {scannedId && (
              <View style={styles.idContainer}>
                <Text style={styles.idLabel}>آخر معرّف تم قراءته:</Text>
                <Text style={styles.idValue}>{scannedId}</Text>
              </View>
            )}

            <TouchableOpacity 
              style={[styles.scanButton, (!isNfcSupported || isLoading) && styles.disabledButton]} 
              onPress={scanNfcCard}
              disabled={!isNfcSupported || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" size="large" />
              ) : (
                <Text style={styles.scanButtonText}>ابدأ مسح البطاقة 💳</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Status Display */}
          <View style={styles.statusContainer}>
            <Text style={styles.statusLabel}>الحالة الحالية:</Text>
            <Text style={styles.statusValue}>{status}</Text>
          </View>
        </View>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080710',
  },
  header: {
    padding: 24,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#aaa',
    marginTop: 6,
  },
  content: {
    flex: 1,
    padding: 20,
    justifyContent: 'space-between',
  },
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  scanCard: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 16,
    textAlign: 'center',
  },
  inputGroup: {
    marginBottom: 12,
  },
  label: {
    fontSize: 14,
    color: '#ccc',
    marginBottom: 6,
    textAlign: 'right',
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 10,
    padding: 12,
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
  },
  testButton: {
    backgroundColor: '#06b6d4',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  scanButton: {
    backgroundColor: '#8b5cf6',
    width: '100%',
    padding: 20,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    elevation: 4,
    shadowColor: '#8b5cf6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  disabledButton: {
    backgroundColor: '#4b3e72',
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  scanButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  idContainer: {
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.2)',
    borderRadius: 10,
    padding: 14,
    width: '100%',
    alignItems: 'center',
    marginBottom: 20,
  },
  idLabel: {
    fontSize: 12,
    color: '#06b6d4',
    marginBottom: 4,
  },
  idValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
    letterSpacing: 1,
  },
  statusContainer: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.01)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  statusLabel: {
    fontSize: 12,
    color: '#888',
    marginBottom: 4,
    textAlign: 'center',
  },
  statusValue: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 22,
  },
});
