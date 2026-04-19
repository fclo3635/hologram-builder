# 🔮 Hologram Builder

A **gesture-controlled 3D holographic builder** powered by AI hand tracking.
Build, rotate, and manipulate 3D objects in real-time using just your hands.

---

## ✨ Features

* 🖐️ Real-time hand tracking (MediaPipe)
* 🧊 3D object creation & manipulation (Three.js)
* 🎮 Gesture-based controls (no mouse/keyboard)
* 💻 Fully offline desktop application (Electron + Python)
* ⚡ Fast and optimized performance

---

## 📥 Download & Install

1. Go to **Releases**
2. Download: `Hologram Builder Setup.exe`
3. Install and run

---

## 🧪 Run Locally (Development)

```bash
npm install
npm start
```

---

## 🧠 Tech Stack

* Electron (Desktop App)
* Python (OpenCV, MediaPipe)
* Three.js (3D rendering)
* WebSockets (real-time communication)

---

## ⚠️ Requirements

* Webcam required
* Good lighting for hand tracking

---

## 📌 Notes

* Works completely offline after installation
* No external dependencies required for users

---

## 📄 License

MIT License

## 🧠 How It Works

1. Camera captures hand movements
2. MediaPipe detects hand landmarks
3. Python sends data via WebSocket
4. Three.js renders 3D objects
5. Gestures control object behavior

## 🚀 Project Highlights

- Built a real-time AI-based gesture system
- Developed full desktop app using Electron
- Integrated Python backend with JS frontend
- Implemented 3D rendering with real-time interaction
