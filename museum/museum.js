import * as THREE from "./vendor/three.module.min.js";

const GIFT = window.GIFT || {};
const $ = (id) => document.getElementById(id);

const name = (GIFT.name || "").trim();
const signature = (GIFT.signature || "").trim();
const dedication = (GIFT.dedication || "").trim();
const givenPhotos = (GIFT.photos || []).map((p) => (typeof p === "string" ? { src: p } : p));

const EYE = 1.6;
const RADIUS = 0.35;
const ROOM_HEIGHT = 4.6;
const SLOT_SPACING = 3;
const PARTITION_THICKNESS = 0.3;
const SAMPLE_COUNT = 12;

/* ---------- Entrance text ---------- */
if (name) {
  $("title").textContent = "For " + name;
  document.title = "Happy Birthday, " + name + "!";
}
$("dedication").textContent = dedication;
if (signature) {
  $("signature").textContent = signature;
  $("signature").hidden = false;
}

/* ---------- Renderer, or a plain photo grid if 3D is unavailable ---------- */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $("scene"), antialias: true });
} catch (err) {
  console.warn("WebGL unavailable", err);
  $("enter").hidden = true;
  $("no-webgl").hidden = false;
  const grid = $("fallback");
  grid.hidden = givenPhotos.length === 0;
  for (const photo of givenPhotos) {
    const img = document.createElement("img");
    img.src = photo.src;
    img.alt = photo.caption || "";
    img.loading = "lazy";
    grid.append(img);
  }
}

if (renderer) start();

function start() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x17141c);
  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 120);
  camera.rotation.order = "YXZ";

  let dirty = true;
  const invalidate = () => { dirty = true; };

  /* ---------- Canvas helpers ---------- */
  function canvasOf(w, h, draw) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d"), w, h);
    return c;
  }

  function textureOf(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    return t;
  }

  function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? line + " " + word : word;
        if (ctx.measureText(next).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  // Draws centred text blocks, shrinking every block until they all fit.
  function drawBlocks(ctx, w, h, blocks, padding) {
    let scale = 1;
    let laid;
    let total;
    for (let tries = 0; tries < 30; tries++) {
      laid = blocks.map((b) => {
        const size = b.size * scale;
        ctx.font = `${b.style || ""} ${size}px ${b.font}`;
        let lines = wrapLines(ctx, b.text, w - padding * 2);
        return { ...b, px: size, lines, height: lines.length * size * 1.32 + (b.gap || 0) * scale };
      });
      total = laid.reduce((sum, b) => sum + b.height, 0);
      const widest = Math.max(...laid.flatMap((b) => {
        ctx.font = `${b.style || ""} ${b.px}px ${b.font}`;
        return b.lines.map((l) => ctx.measureText(l).width);
      }));
      if (total <= h - padding * 2 && widest <= w - padding * 2) break;
      scale *= 0.92;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    let y = (h - total) / 2;
    for (const b of laid) {
      ctx.font = `${b.style || ""} ${b.px}px ${b.font}`;
      ctx.fillStyle = b.color;
      y += (b.gap || 0) * scale;
      for (const line of b.lines) {
        ctx.fillText(line, w / 2, y);
        y += b.px * 1.32;
      }
    }
  }

  const softRect = canvasOf(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(0,0,0,.75)");
    g.addColorStop(0.6, "rgba(0,0,0,.42)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  const softTex = textureOf(softRect);
  const softMat = new THREE.MeshBasicMaterial({ map: softTex, transparent: true, depthWrite: false });

  const frameShadowMat = new THREE.MeshBasicMaterial({ map: softTex, transparent: true, depthWrite: false, opacity: 0.5 });

  const glowTex = textureOf(canvasOf(256, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h * 0.34, 8, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,244,222,.34)");
    g.addColorStop(0.55, "rgba(255,240,214,.13)");
    g.addColorStop(1, "rgba(255,240,214,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }));
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  /* ---------- Room size from how many photos need hanging ---------- */
  const photoCount = givenPhotos.length || SAMPLE_COUNT;
  const onWalls = Math.max(photoCount - 1, 0);

  // Past this many photos, free-standing walls keep the room from getting huge.
  const usePartitions = onWalls > 14;

  function slotsFor(W, D) {
    const slots = [];
    const along = (length, make) => {
      const n = Math.max(Math.floor((length - 1.5) / SLOT_SPACING), 0);
      for (let i = 0; i < n; i++) make((i + 0.5) * (length / n) - length / 2);
    };
    along(D, (t) => slots.push({ x: -W / 2, z: -t, ry: Math.PI / 2 }));        // west
    along(W, (t) => slots.push({ x: t, z: -D / 2, ry: 0 }));                   // north
    along(D, (t) => slots.push({ x: W / 2, z: t, ry: -Math.PI / 2 }));         // east
    const side = (W - 5) / 2;                                                  // south, either side of the entrance
    along(side, (t) => slots.push({ x: 2.5 + side / 2 - t, z: D / 2, ry: Math.PI }));
    along(side, (t) => slots.push({ x: -2.5 - side / 2 - t, z: D / 2, ry: Math.PI }));
    if (usePartitions) {
      const px = W / 3;
      const face = PARTITION_THICKNESS / 2;
      for (const x of [-px, px]) {
        along(D / 2, (t) => slots.push({ x: x + face, z: -t, ry: Math.PI / 2 }));
        along(D / 2, (t) => slots.push({ x: x - face, z: t, ry: -Math.PI / 2 }));
      }
    }
    return slots;
  }

  let W = 16;
  let D = 16;
  while (slotsFor(W, D).length < onWalls) {
    W += 2;
    D += 2;
  }
  const allSlots = slotsFor(W, D);
  const walkSpeed = 2.6 * Math.min(W / 16, 1.6);

  /* ---------- Shell ---------- */
  const clickable = [];
  const colliders = [];

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c8, 2.3));
  const sun = new THREE.DirectionalLight(0xfff6e8, 0.75);
  sun.position.set(4, 8, 6);
  scene.add(sun);

  const floorTex = textureOf(canvasOf(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#c9c4bb";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? "255,255,255" : "70,62,52"},${Math.random() * 0.035})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 3 + Math.random() * 26, 1 + Math.random() * 3);
    }
    ctx.strokeStyle = "rgba(90,82,72,.45)";
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, w, h);
  }));
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(W / 1.2, D / 1.2);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshLambertMaterial({ map: floorTex })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.userData.floor = true;
  scene.add(floor);
  clickable.push(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshBasicMaterial({ color: 0x2a282e })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  scene.add(ceiling);

  const wallTex = textureOf(canvasOf(8, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#9f9c97");
    g.addColorStop(0.2, "#d3d0ca");
    g.addColorStop(0.75, "#dedbd5");
    g.addColorStop(1, "#c6c3bd");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }));
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
  const skirtMat = new THREE.MeshLambertMaterial({ color: 0x8d8983 });
  const blackMat = new THREE.MeshLambertMaterial({ color: 0x111014 });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xe6e3dd });

  for (const [x, z, ry, len] of [
    [0, -D / 2, 0, W],
    [0, D / 2, Math.PI, W],
    [-W / 2, 0, Math.PI / 2, D],
    [W / 2, 0, -Math.PI / 2, D]
  ]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, ROOM_HEIGHT), wallMat);
    wall.position.set(x, ROOM_HEIGHT / 2, z);
    wall.rotation.y = ry;
    scene.add(wall);
    clickable.push(wall);
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.12), skirtMat);
    skirt.position.set(x, 0.06, z);
    skirt.rotation.y = ry;
    skirt.translateZ(0.01);
    scene.add(skirt);
  }

  function box(w, h, d, x, y, z, material, collide = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    clickable.push(mesh);
    if (collide) colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    return mesh;
  }

  function floorShadow(w, d, x, z) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(w, d), softMat);
    s.rotation.x = -Math.PI / 2;
    s.position.set(x, 0.008, z);
    scene.add(s);
  }

  if (usePartitions) {
    for (const x of [-W / 3, W / 3]) {
      box(PARTITION_THICKNESS, 3.5, D / 2, x, 1.75, 0, new THREE.MeshLambertMaterial({ color: 0xdedbd5 }));
      floorShadow(1.4, D / 2 + 0.8, x, 0);
    }
  }

  /* ---------- Ceiling track and lamps ---------- */
  const trackMat = new THREE.MeshBasicMaterial({ color: 0x0c0b0e });
  const lampGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.26, 12);
  const lampGlow = new THREE.MeshBasicMaterial({ color: 0xfff2d6 });
  const lampFace = new THREE.CircleGeometry(0.07, 12);
  const OFF = 1.1;
  for (const [w, d, x, z] of [
    [W - 2 * OFF, 0.05, 0, -D / 2 + OFF],
    [W - 2 * OFF, 0.05, 0, D / 2 - OFF],
    [0.05, D - 2 * OFF, -W / 2 + OFF, 0],
    [0.05, D - 2 * OFF, W / 2 - OFF, 0]
  ]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), trackMat);
    rail.position.set(x, ROOM_HEIGHT - 0.2, z);
    scene.add(rail);
  }

  function lamp(x, z) {
    const body = new THREE.Mesh(lampGeo, trackMat);
    body.position.set(x, ROOM_HEIGHT - 0.34, z);
    scene.add(body);
    const face = new THREE.Mesh(lampFace, lampGlow);
    face.rotation.x = Math.PI / 2;
    face.position.set(x, ROOM_HEIGHT - 0.475, z);
    scene.add(face);
  }

  /* ---------- Framed pictures ---------- */
  const unit = new THREE.PlaneGeometry(1, 1);
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x17151a });
  const matMat = new THREE.MeshBasicMaterial({ color: 0xf6f3ee });
  const pictures = [];

  function samplePicture(index) {
    const hue = (index * 47 + 18) % 360;
    return canvasOf(900, index % 3 === 0 ? 1100 : 700, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${hue} 62% 62%)`);
      g.addColorStop(1, `hsl(${(hue + 55) % 360} 58% 34%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255,255,255,.14)";
      ctx.beginPath();
      ctx.arc(w * 0.72, h * 0.28, w * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,.14)";
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(w * 0.36, h * 0.52);
      ctx.lineTo(w * 0.6, h * 0.78);
      ctx.lineTo(w * 0.8, h * 0.6);
      ctx.lineTo(w, h * 0.86);
      ctx.lineTo(w, h);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "600 62px Fraunces, Georgia, serif";
      ctx.fillText("Sample photo", w / 2, h / 2 - 8);
      ctx.font = "700 40px Nunito, sans-serif";
      ctx.fillText(String(index + 1), w / 2, h / 2 + 52);
    });
  }

  function hangPicture(index, photo, place, maxW, maxH) {
    const group = new THREE.Group();
    group.position.set(place.x, place.y, place.z);
    group.rotation.y = place.ry;
    scene.add(group);

    const glow = new THREE.Mesh(unit, glowMat);
    glow.position.set(0, place.glow ? place.glow.y : 0.25, 0.006);
    group.add(glow);
    const shadow = new THREE.Mesh(unit, frameShadowMat);
    shadow.position.set(0, -0.05, 0.012);
    group.add(shadow);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), frameMat);
    group.add(frame);
    const mat = new THREE.Mesh(unit, matMat);
    group.add(mat);
    const image = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    image.userData.pictureIndex = pictures.length;
    group.add(image);
    clickable.push(image);

    function fit(aspect) {
      let h = maxH;
      let w = h * aspect;
      if (w > maxW) {
        w = maxW;
        h = w / aspect;
      }
      const margin = Math.min(w, h) * 0.09;
      image.scale.set(w, h, 1);
      image.position.z = 0.072;
      mat.scale.set(w + margin * 2, h + margin * 2, 1);
      mat.position.z = 0.066;
      frame.scale.set(w + margin * 2 + 0.1, h + margin * 2 + 0.1, 0.06);
      frame.position.z = 0.032;
      shadow.scale.set((w + margin * 2) * 1.32, (h + margin * 2) * 1.32, 1);
      if (place.glow) glow.scale.set(place.glow.w, place.glow.h, 1);
      else glow.scale.set(Math.max(w * 2.2, 3), Math.max(h * 2.4, 3.6), 1);
      invalidate();
    }

    const entry = { src: photo && photo.src, caption: photo && photo.caption };
    pictures.push(entry);

    function show(texture, aspect) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = maxAniso;
      image.material.map = texture;
      image.material.needsUpdate = true;
      fit(aspect);
    }

    function showSample() {
      const c = samplePicture(index);
      entry.src = c.toDataURL("image/jpeg", 0.85);
      entry.caption = entry.caption || "This is a sample. Your own photo goes here.";
      show(new THREE.CanvasTexture(c), c.width / c.height);
    }

    fit(4 / 5);
    if (photo && photo.src) {
      new THREE.TextureLoader().load(
        photo.src,
        (t) => show(t, t.image.width / t.image.height),
        undefined,
        () => {
          console.warn("Could not load photo:", photo.src);
          showSample();
        }
      );
    } else {
      showSample();
    }
  }

  /* ---------- Centre: black wall, big photo, dedication plinth ---------- */
  const fontsReady = Promise.race([
    Promise.all([
      document.fonts.load('500 40px "Fraunces"'),
      document.fonts.load('italic 500 40px "Fraunces"'),
      document.fonts.load('700 40px "Nunito"')
    ]),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]).catch(() => {});

  const centreZ = -1.5;
  box(8, 4.3, 0.5, 0, 2.15, centreZ, blackMat);
  floorShadow(9.4, 2.2, 0, centreZ);

  hangPicture(0, givenPhotos[0], { x: 0, y: 2.5, z: centreZ + 0.25, ry: 0, glow: { w: 7, h: 3.5, y: 0 } }, 4.6, 2.9);
  lamp(-1.1, centreZ + 2.2);
  lamp(1.1, centreZ + 2.2);

  const plinthZ = centreZ + 2.5;
  const PLINTH_H = 0.8;
  const PLAQUE_TILT = 0.55;
  box(1.3, PLINTH_H, 0.9, 0, PLINTH_H / 2, plinthZ, whiteMat);
  floorShadow(2.2, 1.8, 0, plinthZ);

  const plaqueMat = new THREE.MeshBasicMaterial({ color: 0x1c1a20 });
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8), plaqueMat);
  plaque.position.set(0, PLINTH_H + 0.4 * Math.sin(PLAQUE_TILT) + 0.04, plinthZ);
  plaque.rotation.x = -Math.PI / 2 + PLAQUE_TILT;
  plaque.userData.text = true;
  scene.add(plaque);
  clickable.push(plaque);
  const plaqueBack = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.86, 0.03), blackMat);
  plaqueBack.position.z = -0.018;
  plaque.add(plaqueBack);
  const plaqueStand = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.3), blackMat);
  plaqueStand.position.set(0, PLINTH_H + 0.1, plinthZ - 0.2); // tucked behind the tilted plaque
  scene.add(plaqueStand);

  const heading = name ? "For " + name : "Happy Birthday";
  const dedicationBlocks = (fg, sub) => [
    { text: heading, size: 92, font: "Fraunces, Georgia, serif", style: "500", color: "#e9c46a" },
    { text: dedication, size: 52, font: "Nunito, sans-serif", style: "500", color: fg, gap: 32 },
    ...(signature ? [{ text: signature, size: 56, font: "Fraunces, Georgia, serif", style: "italic 500", color: sub, gap: 32 }] : [])
  ];

  // Back of the centre wall, a birthday greeting, with a bench to sit at
  const backPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(7.2, 3.2),
    new THREE.MeshBasicMaterial({ color: 0x111014 })
  );
  backPanel.position.set(0, 2.25, centreZ - 0.26);
  backPanel.rotation.y = Math.PI;
  backPanel.userData.text = true;
  scene.add(backPanel);
  clickable.push(backPanel);
  lamp(0, centreZ - 2.2);

  // Dedication on the wall beside the way in
  const doorPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 2.4),
    new THREE.MeshBasicMaterial({ color: 0xf6f3ee })
  );
  doorPanel.position.set(0, 2.1, D / 2 - 0.02);
  doorPanel.rotation.y = Math.PI;
  doorPanel.userData.text = true;
  scene.add(doorPanel);
  clickable.push(doorPanel);
  lamp(0, D / 2 - OFF);

  fontsReady.then(() => {
    const plaqueTex = textureOf(canvasOf(1200, 800, (ctx, w, h) => {
      ctx.fillStyle = "#1c1a20";
      ctx.fillRect(0, 0, w, h);
      drawBlocks(ctx, w, h, dedicationBlocks("#f7f1e7", "#e4dbe8"), 70);
    }));
    plaqueMat.map = plaqueTex;
    plaqueMat.color.set(0xffffff);
    plaqueMat.needsUpdate = true;

    backPanel.material.map = textureOf(canvasOf(1800, 800, (ctx, w, h) => {
      ctx.fillStyle = "#111014";
      ctx.fillRect(0, 0, w, h);
      drawBlocks(ctx, w, h, [
        { text: "Happy Birthday", size: 200, font: "Fraunces, Georgia, serif", style: "500", color: "#e9c46a" },
        ...(name ? [{ text: name, size: 170, font: "Fraunces, Georgia, serif", style: "italic 500", color: "#f7f1e7", gap: 20 }] : [])
      ], 80);
    }));
    backPanel.material.color.set(0xffffff);
    backPanel.material.needsUpdate = true;

    doorPanel.material.map = textureOf(canvasOf(1440, 960, (ctx, w, h) => {
      ctx.fillStyle = "#f6f3ee";
      ctx.fillRect(0, 0, w, h);
      drawBlocks(ctx, w, h, [
        { text: heading, size: 104, font: "Fraunces, Georgia, serif", style: "500", color: "#7a4f12" },
        { text: dedication, size: 56, font: "Nunito, sans-serif", style: "500", color: "#26222c", gap: 34 },
        ...(signature ? [{ text: signature, size: 60, font: "Fraunces, Georgia, serif", style: "italic 500", color: "#26222c", gap: 34 }] : [])
      ], 90);
    }));
    doorPanel.material.color.set(0xffffff);
    doorPanel.material.needsUpdate = true;
    invalidate();
  });

  /* ---------- Benches ---------- */
  function bench(x, z, alongX) {
    const w = alongX ? 2.4 : 0.7;
    const d = alongX ? 0.7 : 2.4;
    box(w, 0.1, d, x, 0.46, z, new THREE.MeshLambertMaterial({ color: 0x8a5a33 }));
    const legX = alongX ? w / 2 - 0.2 : 0;
    const legZ = alongX ? 0 : d / 2 - 0.2;
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? 0.1 : 0.6, 0.42, alongX ? 0.6 : 0.1),
        blackMat
      );
      leg.position.set(x + s * legX, 0.21, z + s * legZ);
      scene.add(leg);
    }
    floorShadow(w * 1.5, d * 1.5, x, z);
  }
  bench(0, centreZ - 3.2, true);
  bench(-W / 4 - 1, 3, false);
  bench(W / 4 + 1, 3, false);

  /* ---------- Hang everything else ---------- */
  for (let i = 0; i < onWalls; i++) {
    const slot = allSlots[Math.floor((i * allSlots.length) / onWalls)];
    hangPicture(i + 1, givenPhotos[i + 1], { x: slot.x, y: 1.75, z: slot.z, ry: slot.ry }, 2.3, 1.75);
    const dirx = Math.sin(slot.ry);
    const dirz = Math.cos(slot.ry);
    lamp(slot.x + dirx * OFF, slot.z + dirz * OFF);
  }

  /* ---------- Movement ---------- */
  const player = { x: 0, z: D / 2 - 1.6, yaw: 0, pitch: 0 };
  const keys = new Set();
  const joy = { x: 0, y: 0 };
  let walkTo = null;
  let entered = false;
  let viewerOpen = false;

  function collide(p) {
    p.x = Math.min(W / 2 - RADIUS, Math.max(-W / 2 + RADIUS, p.x));
    p.z = Math.min(D / 2 - RADIUS, Math.max(-D / 2 + RADIUS, p.z));
    for (const c of colliders) {
      const cx = Math.min(c.maxX, Math.max(c.minX, p.x));
      const cz = Math.min(c.maxZ, Math.max(c.minZ, p.z));
      const dx = p.x - cx;
      const dz = p.z - cz;
      const dist = Math.hypot(dx, dz);
      if (dist < RADIUS && dist > 0) {
        p.x = cx + (dx / dist) * RADIUS;
        p.z = cz + (dz / dist) * RADIUS;
      }
    }
  }

  // Moves in short hops so a slow frame can never jump through a wall.
  function advance(dx, dz) {
    const hops = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.1));
    for (let i = 0; i < hops; i++) {
      player.x += dx / hops;
      player.z += dz / hops;
      collide(player);
    }
  }

  function step(dt) {
    let f = joy.y;
    let s = joy.x;
    if (keys.has("KeyW") || keys.has("ArrowUp")) f += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) f -= 1;
    if (keys.has("KeyA")) s -= 1;
    if (keys.has("KeyD")) s += 1;
    if (keys.has("ArrowLeft")) player.yaw += 1.6 * dt;
    if (keys.has("ArrowRight")) player.yaw -= 1.6 * dt;

    const before = { x: player.x, z: player.z };
    if (f || s) {
      walkTo = null;
      const len = Math.max(1, Math.hypot(f, s));
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      advance(
        ((-sin * f + cos * s) / len) * walkSpeed * dt,
        ((-cos * f - sin * s) / len) * walkSpeed * dt
      );
    } else if (walkTo) {
      const dx = walkTo.x - player.x;
      const dz = walkTo.z - player.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.12) {
        walkTo = null;
      } else {
        const move = Math.min(dist, walkSpeed * dt);
        advance((dx / dist) * move, (dz / dist) * move);
      }
    }
    const moved = Math.hypot(player.x - before.x, player.z - before.z);
    if (walkTo && moved < walkSpeed * dt * 0.1) walkTo = null; // blocked by something
    return moved > 0 || keys.has("ArrowLeft") || keys.has("ArrowRight");
  }

  /* ---------- Look by dragging, tap to walk or open ---------- */
  const canvas = $("scene");
  const ray = new THREE.Raycaster();
  let drag = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (drag || !entered) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    player.yaw += (e.clientX - drag.x) * 0.0042;
    player.pitch = Math.max(-1, Math.min(1, player.pitch + (e.clientY - drag.y) * 0.0042));
    drag.x = e.clientX;
    drag.y = e.clientY;
    hideHint();
    invalidate();
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 8 && performance.now() - drag.t < 450;
    drag = null;
    canvas.classList.remove("dragging");
    if (tap && e.type === "pointerup") handleTap(e.clientX, e.clientY);
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  function handleTap(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1),
      camera
    );
    const hit = ray.intersectObjects(clickable, false)[0];
    if (!hit) return;
    hideHint();
    const data = hit.object.userData;
    if (data.pictureIndex !== undefined) {
      openViewer(data.pictureIndex);
    } else if (data.text) {
      openText();
    } else if (data.floor) {
      walkTo = { x: hit.point.x, z: hit.point.z };
    }
  }

  addEventListener("keydown", (e) => {
    if (viewerOpen) {
      if (e.code === "Escape") closeViewer();
      if (e.code === "ArrowLeft") moveViewer(-1);
      if (e.code === "ArrowRight") moveViewer(1);
      return;
    }
    if (!entered) return;
    if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code)) {
      keys.add(e.code);
      e.preventDefault();
      hideHint();
    }
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());

  /* ---------- Joystick ---------- */
  const coarse = matchMedia("(pointer: coarse)").matches;
  const stick = $("stick");
  const knob = $("knob");
  let stickId = null;

  function moveStick(e) {
    const r = stick.getBoundingClientRect();
    const reach = r.width / 2;
    let x = (e.clientX - r.left - reach) / reach;
    let y = (e.clientY - r.top - reach) / reach;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    joy.x = x;
    joy.y = -y;
    knob.style.transform = `translate(${x * (reach - 24)}px, ${y * (reach - 24)}px)`;
  }
  function releaseStick() {
    stickId = null;
    joy.x = joy.y = 0;
    knob.style.transform = "";
  }
  stick.addEventListener("pointerdown", (e) => {
    stickId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    moveStick(e);
    hideHint();
  });
  stick.addEventListener("pointermove", (e) => {
    if (e.pointerId === stickId) moveStick(e);
  });
  stick.addEventListener("pointerup", releaseStick);
  stick.addEventListener("pointercancel", releaseStick);

  /* ---------- Viewer ---------- */
  const viewer = $("viewer");
  const viewerImg = $("viewer-img");
  const viewerCaption = $("viewer-caption");
  let viewing = 0;
  let lastFocus = null;

  function setViewerOpen() {
    viewerOpen = true;
    walkTo = null;
    keys.clear();
    releaseStick();
    lastFocus = document.activeElement;
    viewer.hidden = false;
    $("close").focus();
  }

  function sizeViewerImg() {
    const hasCaption = viewerCaption.textContent ? 90 : 0;
    viewerImg.style.maxHeight = `${Math.max(innerHeight - 96 - hasCaption, 160)}px`;
  }

  function renderViewer() {
    const p = pictures[viewing];
    viewerImg.src = p.src;
    viewerImg.alt = p.caption || `Photo ${viewing + 1}`;
    viewerCaption.textContent = p.caption || "";
    sizeViewerImg();
  }

  function openViewer(index) {
    viewing = index;
    viewerImg.hidden = false;
    viewerCaption.classList.remove("long");
    $("prev").hidden = $("next").hidden = pictures.length < 2;
    renderViewer();
    setViewerOpen();
  }

  function openText() {
    viewerImg.hidden = true;
    viewerImg.removeAttribute("src");
    $("prev").hidden = $("next").hidden = true;
    viewerCaption.textContent = dedication + (signature ? "\n\n" + signature : "");
    viewerCaption.style.whiteSpace = "pre-line";
    viewerCaption.classList.add("long");
    setViewerOpen();
  }

  function moveViewer(by) {
    if (viewerImg.hidden) return;
    viewing = (viewing + by + pictures.length) % pictures.length;
    renderViewer();
  }

  function closeViewer() {
    viewerOpen = false;
    viewer.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    invalidate();
  }

  $("close").addEventListener("click", closeViewer);
  $("prev").addEventListener("click", () => moveViewer(-1));
  $("next").addEventListener("click", () => moveViewer(1));
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) closeViewer();
  });

  /* ---------- Hint and entering ---------- */
  const hint = $("hint");
  let hintTimer;
  function hideHint() {
    clearTimeout(hintTimer);
    hint.classList.add("gone");
  }

  $("enter").addEventListener("click", () => {
    entered = true;
    $("entrance").classList.add("leaving");
    setTimeout(() => { $("entrance").hidden = true; }, 750);
    stick.hidden = !coarse;
    hint.textContent = coarse
      ? "Move with the circle. Drag to look. Tap a photo to see it."
      : "Walk with W A S D or the arrow keys. Drag to look. Click a photo to see it.";
    hint.classList.remove("gone");
    hintTimer = setTimeout(hideHint, 9000);
    canvas.focus?.();
    invalidate();
  });

  /* ---------- Loop ---------- */
  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    if (viewerOpen && !viewerImg.hidden) sizeViewerImg();
    invalidate();
  }
  addEventListener("resize", resize);
  resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.15); // keeps walking speed steady on slow phones
    last = now;
    if (!viewerOpen && step(dt)) dirty = true;
    if (dirty) {
      dirty = false;
      camera.position.set(player.x, EYE, player.z);
      camera.rotation.set(player.pitch, player.yaw, 0);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // State used by automated checks
  window.__museum = { player, pictures, room: { W, D }, invalidate };
}
