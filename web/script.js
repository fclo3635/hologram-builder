import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";

const WORLD = {
  width: 18,
  height: 12,
  depth: 16,
};

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const COLORS = {
  neon: 0x00f4ff,
  neonSoft: 0x78fbff,
  secondary: 0x37b8ff,
  shell: 0x0a3134,
  selected: 0xffffff,
  grid: 0x083339,
  frame: 0x0a525a,
  menuHover: 0x9dffff,
  danger: 0xff6d81,
};

const shapeLabels = {
  cube: "Cube",
  tall_block: "Tall Block",
  flat_plate: "Flat Plate",
  pyramid: "Pyramid",
};

const state = {
  gridSize: 1,
  mode: "single",
  activeShape: "cube",
  menuVisible: false,
  socket: null,
  reconnectTimer: null,
  objects: new Map(),
  objectOrder: [],
  history: [],
  maxHistory: 80,
  selectedId: null,
  scene: null,
  renderer: null,
  cameras: {},
  cursor: null,
  cursorHalo: null,
  cursorBeam: null,
  grid: null,
  chamber: null,
  targetCursor: new THREE.Vector3(0, 6, 0),
  latestHands: {
    left: null,
    right: null,
  },
  hands: {
    left: null,
    right: null,
  },
  hud: {
    wsStatus: document.getElementById("wsStatus"),
    modeValue: document.getElementById("modeValue"),
    shapeValue: document.getElementById("shapeValue"),
    selectedValue: document.getElementById("selectedValue"),
    objectCount: document.getElementById("objectCount"),
    rightGesture: document.getElementById("rightGesture"),
    leftGesture: document.getElementById("leftGesture"),
    toast: document.getElementById("toast"),
  },
  interaction: {
    dragging: false,
    rotating: false,
    scaling: false,
  },
  lastHandFrameAt: 0,
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mapRange(value, inMin, inMax, outMin, outMax) {
  const amount = (value - inMin) / (inMax - inMin);
  return outMin + (outMax - outMin) * amount;
}

function roundNumber(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function snapValue(value) {
  return Math.round(value / state.gridSize) * state.gridSize;
}

function snapVector(vector) {
  return new THREE.Vector3(
    snapValue(vector.x),
    Math.max(0, snapValue(vector.y)),
    snapValue(vector.z),
  );
}

function handToWorld(point) {
  return new THREE.Vector3(
    mapRange(point.x ?? 0.5, 0, 1, -WORLD.width / 2, WORLD.width / 2),
    mapRange(point.y ?? 0.5, 1, 0, 0.3, WORLD.height),
    mapRange(point.z ?? 0.5, 0, 1, WORLD.depth / 2, -WORLD.depth / 2),
  );
}

function showToast(message) {
  const { toast } = state.hud;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 1800);
}

function updateHud() {
  state.hud.modeValue.textContent = "Single Hologram";
  state.hud.shapeValue.textContent = shapeLabels[state.activeShape] || "Cube";
  state.hud.objectCount.textContent = String(state.objectOrder.length);

  if (state.selectedId && state.objects.has(state.selectedId)) {
    const entry = state.objects.get(state.selectedId);
    state.hud.selectedValue.textContent = `${shapeLabels[entry.shape]} #${entry.id.split("-").pop()}`;
  } else {
    state.hud.selectedValue.textContent = "None";
  }

}

function setConnectionStatus(text) {
  state.hud.wsStatus.textContent = text;
}

function createLabelTexture(text, { width = 512, height = 160, accent = "#00f4ff" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(0, 244, 255, 0.26)");
  gradient.addColorStop(1, "rgba(0, 10, 16, 0.9)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(0, 244, 255, 0.5)";
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, width - 16, height - 16);

  ctx.fillStyle = accent;
  ctx.font = `600 ${Math.floor(height * 0.34)}px Trebuchet MS`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 244, 255, 0.9)";
  ctx.shadowBlur = 16;
  ctx.fillText(text, width / 2, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function createMaterialSet() {
  return {
    shell: new THREE.MeshBasicMaterial({
      color: COLORS.neon,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
    }),
    wire: new THREE.MeshBasicMaterial({
      color: COLORS.neon,
      wireframe: true,
      transparent: true,
      opacity: 0.2,
    }),
    edges: new THREE.LineBasicMaterial({
      color: COLORS.neon,
      transparent: true,
      opacity: 0.95,
    }),
  };
}

function createGeometry(shape) {
  switch (shape) {
    case "tall_block":
      return new THREE.BoxGeometry(1, 2.4, 1);
    case "flat_plate":
      return new THREE.BoxGeometry(2.4, 0.4, 2.4);
    case "pyramid":
      return new THREE.ConeGeometry(1.08, 1.7, 4, 1, false);
    case "cube":
    default:
      return new THREE.BoxGeometry(1.2, 1.2, 1.2);
  }
}

function applyEntrySelection(entry, selected) {
  entry.materials.edges.color.setHex(selected ? COLORS.selected : COLORS.neon);
  entry.materials.shell.opacity = selected ? 0.12 : 0.06;
  entry.materials.wire.opacity = selected ? 0.28 : 0.2;
}

function setSelected(id) {
  if (state.selectedId && state.objects.has(state.selectedId)) {
    applyEntrySelection(state.objects.get(state.selectedId), false);
  }

  state.selectedId = id;
  if (id && state.objects.has(id)) {
    applyEntrySelection(state.objects.get(id), true);
  }
  updateHud();
}

function createSceneObject(shape, transform = {}) {
  const id = transform.id || `obj-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const root = new THREE.Group();
  const visual = new THREE.Group();
  root.add(visual);

  const geometry = createGeometry(shape);
  const materials = createMaterialSet();
  const shell = new THREE.Mesh(geometry, materials.shell);
  const wireMesh = new THREE.Mesh(geometry, materials.wire);
  const edgeLines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), materials.edges);
  visual.add(shell, wireMesh, edgeLines);

  root.userData.floatPhase = Math.random() * Math.PI * 2;
  root.userData.targetPosition = new THREE.Vector3();
  root.userData.targetRotationY = 0;
  root.userData.targetScale = new THREE.Vector3(1, 1, 1);
  root.userData.visual = visual;

  state.scene.add(root);
  const entry = { id, shape, root, materials };
  state.objects.set(id, entry);
  state.objectOrder.push(id);
  setObjectTransform(entry, transform);
  applyEntrySelection(entry, false);
  updateHud();
  return entry;
}

function setObjectTransform(entry, transform = {}) {
  const position = transform.position || { x: 0, y: 0, z: 0 };
  const rotation = transform.rotation || { x: 0, y: 0, z: 0 };
  const scale = transform.scale || { x: 1, y: 1, z: 1 };

  entry.root.position.set(position.x ?? 0, position.y ?? 0, position.z ?? 0);
  entry.root.userData.targetPosition.copy(entry.root.position);

  entry.root.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
  entry.root.userData.targetRotationY = rotation.y ?? 0;

  entry.root.scale.set(scale.x ?? 1, scale.y ?? 1, scale.z ?? 1);
  entry.root.userData.targetScale.set(scale.x ?? 1, scale.y ?? 1, scale.z ?? 1);
}

function serializeEntry(entry) {
  const position = entry.root.userData.targetPosition || entry.root.position;
  const scale = entry.root.userData.targetScale || entry.root.scale;
  return {
    id: entry.id,
    shape: entry.shape,
    position: {
      x: roundNumber(position.x),
      y: roundNumber(position.y),
      z: roundNumber(position.z),
    },
    rotation: {
      x: roundNumber(entry.root.rotation.x),
      y: roundNumber(entry.root.userData.targetRotationY ?? entry.root.rotation.y),
      z: roundNumber(entry.root.rotation.z),
    },
    scale: {
      x: roundNumber(scale.x),
      y: roundNumber(scale.y),
      z: roundNumber(scale.z),
    },
  };
}

function snapshotScene() {
  return state.objectOrder
    .map((id) => state.objects.get(id))
    .filter(Boolean)
    .map((entry) => serializeEntry(entry));
}

function pushHistory(reason) {
  state.history.push({ reason, objects: snapshotScene() });
  if (state.history.length > state.maxHistory) {
    state.history.shift();
  }
}

function removeObjectById(id) {
  if (!state.objects.has(id)) {
    return;
  }

  const entry = state.objects.get(id);
  state.scene.remove(entry.root);
  state.objects.delete(id);
  state.objectOrder = state.objectOrder.filter((value) => value !== id);

  if (state.selectedId === id) {
    state.selectedId = null;
  }
  updateHud();
}

function clearScene({ push = true } = {}) {
  if (push && state.objectOrder.length) {
    pushHistory("clear");
  }

  [...state.objectOrder].forEach((id) => removeObjectById(id));
  setSelected(null);
  updateHud();
}

function restoreScene(objects, { push = false } = {}) {
  if (push) {
    pushHistory("restore");
  }

  clearScene({ push: false });
  objects.forEach((item) => createSceneObject(item.shape, item));
  setSelected(null);
  updateHud();
}

function undoLastAction() {
  const previous = state.history.pop();
  if (!previous) {
    showToast("History is empty");
    return;
  }

  restoreScene(previous.objects, { push: false });
  showToast(`Undid ${previous.reason}`);
}

function deleteLastObject() {
  const lastId = state.objectOrder[state.objectOrder.length - 1];
  if (!lastId) {
    showToast("Nothing to delete");
    return;
  }

  pushHistory("delete");
  removeObjectById(lastId);
  setSelected(state.objectOrder[state.objectOrder.length - 1] || null);
  showToast("Deleted last object");
}

function findNearestObject(target) {
  let nearest = null;
  let nearestDistance = Infinity;

  state.objects.forEach((entry) => {
    const distance = entry.root.position.distanceTo(target);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = entry;
    }
  });

  return { nearest, nearestDistance };
}

function beginDragInteraction() {
  state.interaction.dragging = true;
  const snapped = snapVector(state.targetCursor);
  const { nearest, nearestDistance } = findNearestObject(snapped);

  if (nearest && nearestDistance <= state.gridSize * 1.35) {
    pushHistory("move");
    setSelected(nearest.id);
    showToast("Selected object");
    return;
  }

  pushHistory("create");
  const created = createSceneObject(state.activeShape, {
    position: { x: snapped.x, y: snapped.y, z: snapped.z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
  setSelected(created.id);
  showToast(`Built ${shapeLabels[state.activeShape]}`);
}

function createVirtualHand(color) {
  const group = new THREE.Group();
  const joints = [];
  const lineGeometry = new THREE.BufferGeometry();
  const linePositions = new Float32Array(HAND_CONNECTIONS.length * 2 * 3);
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));

  const line = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
    }),
  );
  group.add(line);

  for (let index = 0; index < 21; index += 1) {
    const joint = new THREE.Mesh(
      new THREE.SphereGeometry(index === 0 ? 0.15 : 0.11, 6, 6),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: index === 0 ? 0.88 : 0.78,
      }),
    );
    group.add(joint);
    joints.push(joint);
  }

  const palmGlow = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.58, 40),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    }),
  );
  palmGlow.rotation.x = -Math.PI / 2;
  group.add(palmGlow);

  group.visible = false;

  return {
    group,
    joints,
    line,
    lineGeometry,
    linePositions,
    palmGlow,
    targetPoints: Array.from({ length: 21 }, () => new THREE.Vector3()),
  };
}

function updateVirtualHandTargets(handKey, handState) {
  const visual = state.hands[handKey];
  if (!visual) {
    return;
  }

  visual.group.visible = Boolean(handState?.present);
  if (!handState?.present || !Array.isArray(handState.landmarks) || handState.landmarks.length !== 21) {
    return;
  }

  handState.landmarks.forEach((landmark, index) => {
    visual.targetPoints[index].copy(handToWorld(landmark));
  });

  const wrist = visual.targetPoints[0];
  const indexBase = visual.targetPoints[5];
  const pinkyBase = visual.targetPoints[17];
  visual.palmGlow.position.copy(wrist).add(indexBase).add(pinkyBase).multiplyScalar(1 / 3);
}

function updateCursorTarget(frame) {
  if (frame?.right_hand?.present && Array.isArray(frame.right_hand.landmarks) && frame.right_hand.landmarks.length >= 9) {
    const thumb = handToWorld(frame.right_hand.landmarks[4]);
    const indexTip = handToWorld(frame.right_hand.landmarks[8]);
    state.targetCursor.copy(thumb.lerp(indexTip, 0.5));
    return;
  }

  state.targetCursor.set(
    mapRange(frame.x ?? 0.5, 0, 1, -WORLD.width / 2, WORLD.width / 2),
    mapRange(frame.y ?? 0.5, 1, 0, 0.5, WORLD.height),
    mapRange(frame.z ?? 0.5, 0, 1, WORLD.depth / 2, -WORLD.depth / 2),
  );
}

function handleContinuousRightHand(frame) {
  updateCursorTarget(frame);
  const selected = state.selectedId ? state.objects.get(state.selectedId) : null;

  if (!frame.right_hand?.present) {
    state.interaction.dragging = false;
  } else if (frame.pinch) {
    if (!state.interaction.dragging) {
      beginDragInteraction();
    }

    if (state.selectedId && state.objects.has(state.selectedId)) {
      const snapped = snapVector(state.targetCursor);
      state.objects.get(state.selectedId).root.userData.targetPosition.copy(snapped);
    }
  } else {
    state.interaction.dragging = false;
  }

  if (selected && frame.right_gesture === "rotate") {
    if (!state.interaction.rotating) {
      pushHistory("rotate");
      state.interaction.rotating = true;
    }
    selected.root.userData.targetRotationY = frame.rotation ?? 0;
  } else {
    state.interaction.rotating = false;
  }

  if (selected && frame.right_gesture === "scale") {
    if (!state.interaction.scaling) {
      pushHistory("scale");
      state.interaction.scaling = true;
    }
    selected.root.userData.targetScale.setScalar(clamp(frame.scale ?? 1, 0.65, 2.8));
  } else {
    state.interaction.scaling = false;
  }
}

function sendCommand(payload) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
    return true;
  }
  showToast("WebSocket is not connected");
  return false;
}

function requestSave() {
  if (sendCommand({ type: "save_project", objects: snapshotScene() })) {
    showToast("Saving project");
  }
}

function requestLoad() {
  if (sendCommand({ type: "load_project" })) {
    showToast("Loading project");
  }
}

function requestClear() {
  if (sendCommand({ type: "clear_scene" })) {
    showToast("Clearing scene");
  }
}

function handleEventMessage(event) {
  switch (event.name) {
    case "toggle_menu":
      state.menuVisible = Boolean(event.menu_state);
      updateHud();
      break;
    case "shape_selected":
      state.activeShape = event.shape;
      updateHud();
      showToast(`${shapeLabels[event.shape]} selected`);
      break;
    case "delete_last":
      deleteLastObject();
      break;
    case "undo":
      undoLastAction();
      break;
    case "save_project":
      requestSave();
      break;
    case "load_project":
      requestLoad();
      break;
    default:
      break;
  }
}

function handleSocketMessage(message) {
  switch (message.type) {
    case "server_ready":
      setConnectionStatus("Connected");
      break;
    case "hand_state":
      state.lastHandFrameAt = performance.now();
      state.gridSize = message.grid_size || state.gridSize;
      state.menuVisible = Boolean(message.menu_state);
      state.activeShape = message.shape || state.activeShape;
      state.latestHands.left = message.left_hand || null;
      state.latestHands.right = message.right_hand || null;
      state.hud.rightGesture.textContent = message.right_gesture || "Idle";
      state.hud.leftGesture.textContent = message.left_gesture || "Idle";
      updateVirtualHandTargets("left", message.left_hand);
      updateVirtualHandTargets("right", message.right_hand);
      updateHud();
      if (Array.isArray(message.events)) {
        message.events.forEach(handleEventMessage);
      }
      handleContinuousRightHand(message);
      break;
    case "project_saved":
      showToast(`Saved ${message.count || 0} objects`);
      break;
    case "project_loaded":
      pushHistory("load");
      restoreScene(message.objects || [], { push: false });
      showToast(`Loaded ${message.objects?.length || 0} objects`);
      break;
    case "scene_cleared":
      clearScene({ push: true });
      showToast("Scene cleared");
      break;
    case "error":
      showToast(message.message || "Server error");
      break;
    default:
      break;
  }
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = "127.0.0.1";
  state.socket = new WebSocket(`${protocol}://${host}:8765`);
  setConnectionStatus("Connecting");

  state.socket.addEventListener("open", () => {
    setConnectionStatus("Connected");
    clearInterval(connectSocket.pingTimer);
    connectSocket.pingTimer = setInterval(() => {
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 10_000);
  });

  state.socket.addEventListener("message", (event) => {
    handleSocketMessage(JSON.parse(event.data));
  });

  state.socket.addEventListener("close", () => {
    setConnectionStatus("Reconnecting");
    clearInterval(connectSocket.pingTimer);
    state.reconnectTimer = setTimeout(connectSocket, 1500);
  });

  state.socket.addEventListener("error", () => {
    setConnectionStatus("Error");
  });
}

function buildScene() {
  const canvas = document.getElementById("hologram");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.style.filter = "drop-shadow(0 0 12px rgba(0, 244, 255, 0.36))";

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const grid = new THREE.GridHelper(26, 26, COLORS.neon, COLORS.grid);
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  scene.add(grid);

  const chamber = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(WORLD.width, WORLD.height, WORLD.depth)),
    new THREE.LineBasicMaterial({
      color: COLORS.frame,
      transparent: true,
      opacity: 0.46,
    }),
  );
  chamber.position.y = WORLD.height / 2;
  scene.add(chamber);

  const cursor = new THREE.Group();
  const cursorMesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.36, 0),
    new THREE.MeshBasicMaterial({
      color: COLORS.neon,
      wireframe: true,
      transparent: true,
      opacity: 0.82,
    }),
  );
  const cursorHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.44, 0.58, 32),
    new THREE.MeshBasicMaterial({
      color: COLORS.neonSoft,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
    }),
  );
  cursorHalo.rotation.x = -Math.PI / 2;
  const cursorBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.05, 1, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: COLORS.neon,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
    }),
  );
  cursor.add(cursorMesh, cursorHalo, cursorBeam);
  scene.add(cursor);

  state.scene = scene;
  state.renderer = renderer;
  state.grid = grid;
  state.chamber = chamber;
  state.cursor = cursor;
  state.cursorHalo = cursorHalo;
  state.cursorBeam = cursorBeam;

  state.hands.left = createVirtualHand(COLORS.secondary);
  state.hands.right = createVirtualHand(COLORS.neon);
  scene.add(state.hands.left.group);
  scene.add(state.hands.right.group);

  const makeCamera = (x, y, z) => {
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(x, y, z);
    camera.lookAt(0, 4.3, 0);
    return camera;
  };

  state.cameras = {
    main: makeCamera(13, 10, 15),
  };
}

function updateAnimatedObjects(timeSeconds) {
  state.objects.forEach((entry) => {
    entry.root.position.lerp(entry.root.userData.targetPosition, 0.22);
    entry.root.rotation.y += (entry.root.userData.targetRotationY - entry.root.rotation.y) * 0.18;
    entry.root.scale.lerp(entry.root.userData.targetScale, 0.22);
    entry.root.userData.visual.position.y = Math.sin(timeSeconds * 1.8 + entry.root.userData.floatPhase) * 0.12;
  });

  Object.values(state.hands).forEach((visual) => {
    if (!visual) {
      return;
    }

    visual.joints.forEach((joint, index) => {
      joint.position.lerp(visual.targetPoints[index], 0.34);
    });

    HAND_CONNECTIONS.forEach(([from, to], connectionIndex) => {
      const start = visual.joints[from].position;
      const end = visual.joints[to].position;
      const baseIndex = connectionIndex * 6;
      visual.linePositions[baseIndex] = start.x;
      visual.linePositions[baseIndex + 1] = start.y;
      visual.linePositions[baseIndex + 2] = start.z;
      visual.linePositions[baseIndex + 3] = end.x;
      visual.linePositions[baseIndex + 4] = end.y;
      visual.linePositions[baseIndex + 5] = end.z;
    });
    visual.lineGeometry.attributes.position.needsUpdate = true;
    visual.palmGlow.rotation.z += 0.01;
  });

  const rightHandVisible = Boolean(state.latestHands.right?.present);
  state.cursor.visible = rightHandVisible;
  state.cursor.position.lerp(state.targetCursor, 0.28);
  state.cursor.rotation.y += 0.03;
  state.cursorHalo.rotation.z -= 0.015;

  const beamHeight = Math.max(state.cursor.position.y, 0.1);
  state.cursorBeam.scale.set(1, beamHeight, 1);
  state.cursorBeam.position.set(0, -beamHeight / 2, 0);

}

function animate(now) {
  requestAnimationFrame(animate);
  const timeSeconds = now * 0.001;
  updateAnimatedObjects(timeSeconds);

  state.cameras.main.aspect = window.innerWidth / window.innerHeight;
  state.cameras.main.updateProjectionMatrix();
  state.renderer.render(state.scene, state.cameras.main);
}

function handleResize() {
  state.renderer.setSize(window.innerWidth, window.innerHeight);
}

function bindUi() {
  window.addEventListener("resize", handleResize);
}

function init() {
  buildScene();
  bindUi();
  updateHud();
  connectSocket();
  requestAnimationFrame(animate);
}

init();
