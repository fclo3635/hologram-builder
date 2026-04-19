from __future__ import annotations
import sys
import os

venv_path = os.path.join(os.path.dirname(__file__), "..", "venv", "Lib", "site-packages")
sys.path.insert(0, os.path.abspath(venv_path))
import argparse
import asyncio
import json
import math
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Deque

import cv2
import mediapipe as mp
from mediapipe.python.solutions import hands as hands_module
import websockets


ROOT_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT_DIR / "web"
DATA_DIR = ROOT_DIR / "data"
SAVE_PATH = DATA_DIR / "save.json"
SUPPORTED_SHAPES = ("cube", "tall_block", "flat_plate", "pyramid")


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def distance_2d(point_a: tuple[float, float], point_b: tuple[float, float]) -> float:
    return math.dist(point_a, point_b)


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    ws_port: int = 8765
    http_port: int = 8000
    grid_size: float = 1.0
    camera_index: int = 0
    camera_width: int = 960
    camera_height: int = 540
    preview: bool = True
    serve_only: bool = False
    min_detection_confidence: float = 0.7
    min_tracking_confidence: float = 0.6
    model_complexity: int = 0
    max_fps: int = 30


class CooldownRegistry:
    def __init__(self) -> None:
        self.timestamps: dict[str, float] = {}

    def ready(self, name: str, cooldown_seconds: float, now: float) -> bool:
        previous = self.timestamps.get(name, 0.0)
        if now - previous >= cooldown_seconds:
            self.timestamps[name] = now
            return True
        return False


class StableGestureTracker:
    def __init__(self, stable_frames: int = 4) -> None:
        self.stable_frames = stable_frames
        self.state: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"candidate": None, "count": 0}
        )

    def update(self, slot: str, raw_gesture: str | None) -> str | None:
        entry = self.state[slot]
        if raw_gesture is None:
            entry["candidate"] = None
            entry["count"] = 0
            return None

        if raw_gesture == entry["candidate"]:
            entry["count"] += 1
        else:
            entry["candidate"] = raw_gesture
            entry["count"] = 1

        if entry["count"] >= self.stable_frames:
            return raw_gesture
        return None


class GestureInterpreter:
    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self.cooldowns = CooldownRegistry()
        self.left_tracker = StableGestureTracker(stable_frames=4)
        self.motion_history: dict[str, Deque[tuple[float, float, float]]] = defaultdict(
            lambda: deque(maxlen=8)
        )
        self.menu_state = False
        self.active_shape = "cube"
        self.last_left_event: str | None = None

    def empty_hand(self, hand_type: str) -> dict[str, Any]:
        return {
            "present": False,
            "hand_type": hand_type.lower(),
            "x": 0.5,
            "y": 0.5,
            "z": 0.5,
            "pinch": False,
            "pinch_strength": 0.0,
            "finger_states": {
                "thumb": False,
                "index": False,
                "middle": False,
                "ring": False,
                "pinky": False,
            },
            "finger_count": 0,
            "spread": 0.0,
            "rotation_angle": 0.0,
            "scale_factor": 1.0,
            "velocity": 0.0,
            "gesture": None,
            "landmarks": [],
        }

    def _serialize_landmarks(self, landmarks: Any) -> list[dict[str, float]]:
        serialized: list[dict[str, float]] = []
        for landmark in landmarks:
            serialized.append(
                {
                    "x": round(clamp(1.0 - landmark.x, 0.0, 1.0), 4),
                    "y": round(clamp(landmark.y, 0.0, 1.0), 4),
                    "z": round(clamp(0.5 + (-landmark.z * 1.8), 0.0, 1.0), 4),
                }
            )
        return serialized

    def _finger_states(self, hand_label: str, landmarks: Any) -> dict[str, bool]:
        thumb_tip = landmarks[4]
        thumb_ip = landmarks[3]
        if hand_label == "Right":
            thumb_open = thumb_tip.x < thumb_ip.x - 0.015
        else:
            thumb_open = thumb_tip.x > thumb_ip.x + 0.015

        fingers = {
            "thumb": thumb_open,
            "index": landmarks[8].y < landmarks[6].y - 0.015,
            "middle": landmarks[12].y < landmarks[10].y - 0.015,
            "ring": landmarks[16].y < landmarks[14].y - 0.015,
            "pinky": landmarks[20].y < landmarks[18].y - 0.015,
        }
        return fingers

    def _swipe_state(self, hand_label: str) -> tuple[str | None, float]:
        history = self.motion_history[hand_label]
        if len(history) < 5:
            return None, 0.0

        start_time, start_x, start_y = history[0]
        end_time, end_x, end_y = history[-1]
        delta_time = max(end_time - start_time, 1e-5)
        delta_x = end_x - start_x
        delta_y = end_y - start_y
        velocity_x = delta_x / delta_time

        if abs(delta_x) > 0.18 and abs(velocity_x) > 0.65 and abs(delta_y) < 0.12:
            return ("swipe_right" if delta_x > 0 else "swipe_left"), velocity_x

        return None, velocity_x

    def _extract_hand_state(
        self, hand_label: str, landmarks: Any, now: float
    ) -> dict[str, Any]:
        wrist = landmarks[0]
        index_tip = landmarks[8]
        thumb_tip = landmarks[4]
        middle_mcp = landmarks[9]
        index_mcp = landmarks[5]
        pinky_mcp = landmarks[17]

        palm_width = max(
            distance_2d((index_mcp.x, index_mcp.y), (pinky_mcp.x, pinky_mcp.y)),
            0.08,
        )
        pinch_distance = distance_2d((thumb_tip.x, thumb_tip.y), (index_tip.x, index_tip.y))
        pinch_ratio = pinch_distance / palm_width
        pinch = pinch_ratio < 0.36
        pinch_strength = clamp(1.0 - pinch_ratio / 0.36, 0.0, 1.0)

        fingers = self._finger_states(hand_label, landmarks)
        finger_count = sum(1 for value in fingers.values() if value)
        control_x = (thumb_tip.x + index_tip.x) * 0.5 if pinch else index_tip.x
        control_y = (thumb_tip.y + index_tip.y) * 0.5 if pinch else index_tip.y
        mirrored_x = clamp(1.0 - control_x, 0.0, 1.0)
        depth = clamp(0.5 + (-middle_mcp.z * 1.8), 0.0, 1.0)
        spread = distance_2d((landmarks[8].x, landmarks[8].y), (landmarks[20].x, landmarks[20].y))
        spread_ratio = spread / palm_width
        rotation_angle = math.atan2(index_mcp.y - pinky_mcp.y, index_mcp.x - pinky_mcp.x)
        scale_factor = clamp(0.65 + (spread_ratio - 0.75) * 0.9, 0.65, 2.8)

        self.motion_history[hand_label].append((now, mirrored_x, control_y))
        _, velocity_x = self._swipe_state(hand_label)

        return {
            "present": True,
            "hand_type": hand_label.lower(),
            "x": mirrored_x,
            "y": clamp(control_y, 0.0, 1.0),
            "z": depth,
            "pinch": pinch,
            "pinch_strength": round(pinch_strength, 4),
            "finger_states": fingers,
            "finger_count": finger_count,
            "spread": round(spread_ratio, 4),
            "rotation_angle": round(rotation_angle, 4),
            "scale_factor": round(scale_factor, 4),
            "velocity": round(velocity_x, 4),
            "wrist": {
                "x": round(1.0 - wrist.x, 4),
                "y": round(wrist.y, 4),
                "z": round(clamp(0.5 + (-wrist.z * 1.5), 0.0, 1.0), 4),
            },
            "thumb_tip_y": round(thumb_tip.y, 4),
            "landmarks": self._serialize_landmarks(landmarks),
        }

    def _classify_right_gesture(self, hand: dict[str, Any]) -> str:
        fingers = hand["finger_states"]
        rotate_ready = (
            fingers["index"]
            and fingers["middle"]
            and not fingers["ring"]
            and not fingers["pinky"]
            and hand["spread"] < 1.5
        )
        scale_ready = hand["finger_count"] >= 4 and not hand["pinch"]

        if hand["pinch"]:
            return "pinch"
        if rotate_ready:
            return "rotate"
        if scale_ready:
            return "scale"
        return "move"

    def _classify_left_gesture(self, hand: dict[str, Any]) -> str | None:
        if not hand["present"]:
            return None

        fingers = hand["finger_states"]
        swipe, velocity_x = self._swipe_state("Left")
        open_palm = hand["finger_count"] == 5
        fist = hand["finger_count"] == 0
        ok_sign = hand["pinch"] and fingers["middle"] and fingers["ring"] and fingers["pinky"]
        l_sign = (
            fingers["thumb"]
            and fingers["index"]
            and not fingers["middle"]
            and not fingers["ring"]
            and not fingers["pinky"]
            and not hand["pinch"]
        )
        thumb_up = (
            fingers["thumb"]
            and not fingers["index"]
            and not fingers["middle"]
            and not fingers["ring"]
            and not fingers["pinky"]
            and hand["thumb_tip_y"] < hand["wrist"]["y"] - 0.02
        )

        if swipe and open_palm and abs(velocity_x) > 0.65:
            return "undo"
        if ok_sign:
            return "save_project"
        if l_sign:
            return "load_project"
        if thumb_up:
            return "select_pyramid"
        if fist:
            return "delete_last"
        if open_palm and abs(velocity_x) < 0.22:
            return "toggle_menu"
        if fingers["index"] and fingers["middle"] and not fingers["ring"] and not fingers["pinky"] and not fingers["thumb"]:
            return "select_cube"
        if fingers["index"] and fingers["middle"] and fingers["ring"] and not fingers["pinky"] and not fingers["thumb"]:
            return "select_tall_block"
        if fingers["index"] and fingers["middle"] and fingers["ring"] and fingers["pinky"] and not fingers["thumb"]:
            return "select_flat_plate"
        return None

    def _event_from_left_gesture(self, gesture: str, now: float) -> dict[str, Any] | None:
        cooldowns = {
            "toggle_menu": 0.9,
            "select_cube": 0.55,
            "select_tall_block": 0.55,
            "select_flat_plate": 0.55,
            "select_pyramid": 0.55,
            "delete_last": 0.9,
            "undo": 0.95,
            "save_project": 1.0,
            "load_project": 1.0,
        }
        if not self.cooldowns.ready(gesture, cooldowns.get(gesture, 0.75), now):
            return None

        if gesture == "toggle_menu":
            self.menu_state = not self.menu_state
            return {"name": "toggle_menu", "menu_state": self.menu_state}
        if gesture == "select_cube":
            self.active_shape = "cube"
            return {"name": "shape_selected", "shape": "cube"}
        if gesture == "select_tall_block":
            self.active_shape = "tall_block"
            return {"name": "shape_selected", "shape": "tall_block"}
        if gesture == "select_flat_plate":
            self.active_shape = "flat_plate"
            return {"name": "shape_selected", "shape": "flat_plate"}
        if gesture == "select_pyramid":
            self.active_shape = "pyramid"
            return {"name": "shape_selected", "shape": "pyramid"}
        if gesture == "delete_last":
            return {"name": "delete_last"}
        if gesture == "undo":
            return {"name": "undo"}
        if gesture == "save_project":
            return {"name": "save_project"}
        if gesture == "load_project":
            return {"name": "load_project"}
        return None

    def frame_payload(self, results: Any, now: float) -> dict[str, Any]:
        hands = {
            "Left": self.empty_hand("Left"),
            "Right": self.empty_hand("Right"),
        }

        if results and results.multi_hand_landmarks and results.multi_handedness:
            for hand_landmarks, handedness in zip(
                results.multi_hand_landmarks, results.multi_handedness
            ):
                label = handedness.classification[0].label
                if label in hands:
                    hands[label] = self._extract_hand_state(label, hand_landmarks.landmark, now)

        right_gesture = None
        if hands["Right"]["present"]:
            right_gesture = self._classify_right_gesture(hands["Right"])
            hands["Right"]["gesture"] = right_gesture

        left_raw = self._classify_left_gesture(hands["Left"])
        left_confirmed = self.left_tracker.update("Left", left_raw)
        hands["Left"]["gesture"] = left_confirmed or left_raw

        events: list[dict[str, Any]] = []
        if left_confirmed is None:
            self.last_left_event = None
        elif left_confirmed != self.last_left_event:
            event = self._event_from_left_gesture(left_confirmed, now)
            if event is not None:
                events.append(event)
            self.last_left_event = left_confirmed

        return {
            "type": "hand_state",
            "timestamp": round(now, 4),
            "grid_size": self.config.grid_size,
            "x": hands["Right"]["x"],
            "y": hands["Right"]["y"],
            "z": hands["Right"]["z"],
            "pinch": hands["Right"]["pinch"],
            "shape": self.active_shape,
            "rotation": hands["Right"]["rotation_angle"],
            "scale": hands["Right"]["scale_factor"],
            "menu_state": self.menu_state,
            "right_gesture": right_gesture or "idle",
            "left_gesture": left_confirmed or left_raw or "idle",
            "events": events,
            "right_hand": hands["Right"],
            "left_hand": hands["Left"],
        }


class GestureWebSocketServer:
    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self.interpreter = GestureInterpreter(config)
        self.clients: set[Any] = set()
        self.http_server: ThreadingHTTPServer | None = None
        self.http_thread: threading.Thread | None = None
        self.shutdown_requested = False
        self.last_payload = self.interpreter.frame_payload(results=None, now=time.time())
        self.last_broadcast_at = 0.0

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not SAVE_PATH.exists():
            SAVE_PATH.write_text(
                json.dumps({"saved_at": None, "grid_size": config.grid_size, "objects": []}, indent=2),
                encoding="utf-8",
            )

    def start_http_server(self) -> None:
        handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_DIR))
        self.http_server = ThreadingHTTPServer((self.config.host, self.config.http_port), handler)
        self.http_thread = threading.Thread(
            target=self.http_server.serve_forever,
            daemon=True,
            name="gesture-builder-http",
        )
        self.http_thread.start()

    def stop_http_server(self) -> None:
        if self.http_server is not None:
            self.http_server.shutdown()
            self.http_server.server_close()
            self.http_server = None

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self.clients:
            return

        message = json.dumps(payload)
        stale_clients: list[Any] = []
        for client in list(self.clients):
            try:
                await client.send(message)
            except Exception:
                stale_clients.append(client)

        for client in stale_clients:
            self.clients.discard(client)

    async def _send_to(self, websocket: Any, payload: dict[str, Any]) -> None:
        await websocket.send(json.dumps(payload))

    async def handle_client_message(self, websocket: Any, message: dict[str, Any]) -> None:
        command = message.get("type")

        if command == "save_project":
            objects = message.get("objects", [])
            payload = {
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "grid_size": self.config.grid_size,
                "objects": objects,
            }
            SAVE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            await self.broadcast(
                {
                    "type": "project_saved",
                    "saved_at": payload["saved_at"],
                    "count": len(objects),
                }
            )
            return

        if command == "load_project":
            saved_payload = json.loads(SAVE_PATH.read_text(encoding="utf-8"))
            await self.broadcast(
                {
                    "type": "project_loaded",
                    "saved_at": saved_payload.get("saved_at"),
                    "objects": saved_payload.get("objects", []),
                }
            )
            return

        if command == "clear_scene":
            await self.broadcast({"type": "scene_cleared"})
            return

        if command == "change_mode":
            mode = message.get("mode", "hologram")
            await self.broadcast({"type": "mode_changed", "mode": mode})
            return

        if command == "ping":
            await self._send_to(websocket, {"type": "pong", "timestamp": time.time()})

    async def websocket_handler(self, websocket: Any, _path: str | None = None) -> None:
        self.clients.add(websocket)
        await self._send_to(
            websocket,
            {
                "type": "server_ready",
                "http_url": f"http://{self.config.host}:{self.config.http_port}",
                "ws_url": f"ws://{self.config.host}:{self.config.ws_port}",
                "grid_size": self.config.grid_size,
            },
        )
        await self._send_to(websocket, self.last_payload)

        try:
            async for raw_message in websocket:
                try:
                    message = json.loads(raw_message)
                except json.JSONDecodeError:
                    await self._send_to(
                        websocket,
                        {"type": "error", "message": "Invalid JSON payload received by server."},
                    )
                    continue
                await self.handle_client_message(websocket, message)
        finally:
            self.clients.discard(websocket)

    def _draw_overlay(self, frame: Any, results: Any, payload: dict[str, Any]) -> Any:
        display = frame.copy()
        drawing = mp.solutions.drawing_utils
        drawing_styles = mp.solutions.drawing_styles

        if results and results.multi_hand_landmarks:
            for hand_landmarks in results.multi_hand_landmarks:
                drawing.draw_landmarks(
                    display,
                    hand_landmarks,
                    mp.solutions.hands.HAND_CONNECTIONS,
                    drawing_styles.get_default_hand_landmarks_style(),
                    drawing_styles.get_default_hand_connections_style(),
                )

        lines = [
            "Gesture-Controlled Geometry Builder",
            f"Active shape: {payload['shape']}",
            f"Menu: {'ON' if payload['menu_state'] else 'OFF'}",
            f"Right gesture: {payload['right_gesture']}",
            f"Left gesture: {payload['left_gesture']}",
            "Keyboard: Q or ESC to quit preview",
        ]
        y = 32
        for line in lines:
            cv2.putText(
                display,
                line,
                (16, y),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.68,
                (0, 255, 255),
                2,
                cv2.LINE_AA,
            )
            y += 28

        return display

    async def vision_loop(self) -> None:
        if self.config.serve_only:
            while not self.shutdown_requested:
                self.last_payload = self.interpreter.frame_payload(results=None, now=time.time())
                await self.broadcast(self.last_payload)
                await asyncio.sleep(1 / 20)
            return

        capture = cv2.VideoCapture(self.config.camera_index)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.config.camera_width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.config.camera_height)
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        if not capture.isOpened():
            raise RuntimeError("Unable to open the webcam. Check --camera-index or webcam permissions.")

        hands_module = mp.solutions.hands
        with hands_module.Hands(
            model_complexity=self.config.model_complexity,
            max_num_hands=2,
            min_detection_confidence=self.config.min_detection_confidence,
            min_tracking_confidence=self.config.min_tracking_confidence,
        ) as hands:
            while not self.shutdown_requested:
                success, frame = capture.read()
                if not success:
                    await asyncio.sleep(0.02)
                    continue

                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                rgb_frame.flags.writeable = False
                results = hands.process(rgb_frame)
                now = time.time()
                if now - self.last_broadcast_at >= 1 / max(self.config.max_fps, 1):
                    self.last_payload = self.interpreter.frame_payload(results=results, now=now)
                    await self.broadcast(self.last_payload)
                    self.last_broadcast_at = now

                if self.config.preview:
                    preview = self._draw_overlay(frame, results, self.last_payload)
                    cv2.imshow("Gesture Builder Controller", preview)
                    key = cv2.waitKey(1) & 0xFF
                    if key in (27, ord("q")):
                        self.shutdown_requested = True
                        break

                await asyncio.sleep(0.001)

        capture.release()
        cv2.destroyAllWindows()

    async def run(self) -> None:
        self.start_http_server()
        print(
            f"[server] Web app: http://{self.config.host}:{self.config.http_port}\n"
            f"[server] WebSocket: ws://{self.config.host}:{self.config.ws_port}\n"
            f"[server] Grid size: {self.config.grid_size}"
        )

        async with websockets.serve(
            self.websocket_handler,
            self.config.host,
            self.config.ws_port,
            ping_interval=20,
            max_size=2_000_000,
        ):
            try:
                await self.vision_loop()
            finally:
                self.stop_http_server()


def parse_args() -> ServerConfig:
    parser = argparse.ArgumentParser(
        description="Gesture-Controlled Real-Time 3D Holographic Geometry Builder"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--ws-port", type=int, default=8765)
    parser.add_argument("--http-port", type=int, default=8000)
    parser.add_argument("--grid-size", type=float, default=1.0)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--camera-width", type=int, default=960)
    parser.add_argument("--camera-height", type=int, default=540)
    parser.add_argument("--no-preview", action="store_true")
    parser.add_argument("--serve-only", action="store_true")
    parser.add_argument("--min-detection-confidence", type=float, default=0.7)
    parser.add_argument("--min-tracking-confidence", type=float, default=0.6)
    parser.add_argument("--max-fps", type=int, default=30)
    parser.add_argument("--model-complexity", type=int, choices=(0, 1), default=0)
    args = parser.parse_args()

    return ServerConfig(
        host=args.host,
        ws_port=args.ws_port,
        http_port=args.http_port,
        grid_size=args.grid_size,
        camera_index=args.camera_index,
        camera_width=args.camera_width,
        camera_height=args.camera_height,
        preview=not args.no_preview,
        serve_only=args.serve_only,
        min_detection_confidence=args.min_detection_confidence,
        min_tracking_confidence=args.min_tracking_confidence,
        model_complexity=args.model_complexity,
        max_fps=args.max_fps,
    )


def main() -> None:
    config = parse_args()
    try:
        asyncio.run(GestureWebSocketServer(config).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
