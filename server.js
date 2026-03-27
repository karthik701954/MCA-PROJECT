// server.js
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 8080;

// middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// helper to ensure users.json exists
function ensureFile(filename, defaultData) {
  if (!fs.existsSync(filename)) {
    fs.writeFileSync(filename, JSON.stringify(defaultData, null, 2));
  }
}
function readUsers() {
  ensureFile("users.json", { users: [] });
  return JSON.parse(fs.readFileSync("users.json", "utf8"));
}
function writeUsers(data) {
  fs.writeFileSync("users.json", JSON.stringify(data, null, 2));
}

// ✅ BUS STOPS PERSISTENCE
function readBusStops() {
  ensureFile("stops.json", { stops: {} });
  return JSON.parse(fs.readFileSync("stops.json", "utf8"));
}
function writeBusStops(data) {
  fs.writeFileSync("stops.json", JSON.stringify(data, null, 2));
}

// ✅ LOAD STOPS FROM FILE AT STARTUP
const stopsData = readBusStops();
let busStops = stopsData.stops || {};

// ✅ MULTI-BUS STATE WITH MULTIPLE STOPS
// Structure: { "driver@email.com": { driverName, latitude, longitude, active, lastUpdated, socketId, stops: [{name, lat, lng, order}, ...], currentStopIndex } }
let buses = {};

// Helper: Get all active buses as array
function getActiveBuses() {
  return Object.entries(buses)
    .filter(([email, bus]) => bus.active)
    .map(([email, bus]) => {
      const persistedStops = busStops[email] || [];
      return {
        driverEmail: email,
        driverName: bus.driverName,
        latitude: bus.latitude,
        longitude: bus.longitude,
        lastUpdated: bus.lastUpdated,
        stops: persistedStops,
        currentStopIndex: bus.currentStopIndex || 0
      };
    });
}

// routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/signup", (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ message: "All fields are required." });
  }
  const data = readUsers();
  if (data.users.find(u => u.email === email)) {
    return res.status(400).json({ message: "User already exists." });
  }
  data.users.push({ name, email, password, role });
  writeUsers(data);
  res.json({ message: "User registered successfully." });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password required." });
  const data = readUsers();
  const user = data.users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ message: "Invalid credentials." });
  res.json({ message: "Login successful", user: { name: user.name, email: user.email, role: user.role } });
});

// ✅ API: Get all active buses (optional REST endpoint)
app.get("/api/buses", (req, res) => {
  res.json(getActiveBuses());
});

// ✅ API: Get all buses with their stops (for student view)
app.get("/api/buses-with-stops", (req, res) => {
  const busesWithStops = Object.entries(buses)
    .map(([email, bus]) => ({
      driverEmail: email,
      driverName: bus.driverName,
      latitude: bus.latitude,
      longitude: bus.longitude,
      lastUpdated: bus.lastUpdated,
      active: bus.active,
      stops: busStops[email] || [],
      currentStopIndex: bus.currentStopIndex || 0
    }));
  res.json(busesWithStops);
});

// ✅ API: Get specific driver's bus status
app.get("/api/bus/:email", (req, res) => {
  const email = req.params.email;
  if (buses[email]) {
    res.json(buses[email]);
  } else {
    res.json({ active: false });
  }
});

// ✅ SOCKET.IO - MULTI-DRIVER SUPPORT
io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  // Student requests all current bus locations
  socket.on("request-current", () => {
    socket.emit("all-buses", getActiveBuses());
  });

  // Driver joins their own room for isolated updates
  socket.on("driver-join", (data) => {
    if (data && data.driverEmail) {
      socket.join(`driver-${data.driverEmail}`);
      console.log(`🚍 Driver joined room: driver-${data.driverEmail}`);
      
      // Send driver their stored stops immediately
      const driverStops = busStops[data.driverEmail] || [];
      socket.emit("my-stops", driverStops);
    }
  });

  // Driver requests their stops
  socket.on("get-my-stops", (data) => {
    if (data && data.driverEmail) {
      const driverStops = busStops[data.driverEmail] || [];
      socket.emit("my-stops", driverStops);
    }
  });

  // Driver sends location update
  socket.on("driver-location", (data) => {
    if (!data || data.latitude == null || data.longitude == null || !data.driverEmail) {
      return;
    }

    const { driverEmail, driverName, latitude, longitude } = data;

    // Update or create bus entry for this driver
    buses[driverEmail] = {
      ...(buses[driverEmail] || {}),
      driverName: driverName || "Unknown Driver",
      latitude: parseFloat(latitude).toFixed(6),
      longitude: parseFloat(longitude).toFixed(6),
      active: true,
      lastUpdated: new Date().toISOString(),
      socketId: socket.id
    };

    console.log(`📍 Location update from ${driverName}: ${latitude}, ${longitude}`);

    // Broadcast all active buses to all students
    io.emit("all-buses", getActiveBuses());
  });

  // ✅ ADD BUS STOP
  socket.on("add-stop", (data) => {
    if (!data || !data.driverEmail || !data.stopName) return;

    const { driverEmail, stopName, latitude, longitude } = data;

    // Initialize stops array if doesn't exist
    if (!busStops[driverEmail]) {
      busStops[driverEmail] = [];
    }

    const newStop = {
      name: stopName,
      latitude: parseFloat(latitude || 0).toFixed(6),
      longitude: parseFloat(longitude || 0).toFixed(6),
      order: busStops[driverEmail].length + 1,
      id: Date.now()
    };

    busStops[driverEmail].push(newStop);
    writeBusStops({ stops: busStops });
    console.log(`✅ Stop added for ${driverEmail}: ${stopName}`);

    // Broadcast updated bus info to all students
    io.emit("all-buses", getActiveBuses());
    
    // Send updated stops back to the driver
    io.to(`driver-${driverEmail}`).emit("my-stops", busStops[driverEmail]);
  });

  // ✅ REMOVE BUS STOP
  socket.on("remove-stop", (data) => {
    if (!data || !data.driverEmail || data.stopId == null) return;

    const { driverEmail, stopId } = data;

    if (busStops[driverEmail]) {
      busStops[driverEmail] = busStops[driverEmail].filter(s => s.id !== stopId);
      writeBusStops({ stops: busStops });
      console.log(`🗑️ Stop removed for ${driverEmail}`);
      
      // Broadcast updated bus info to all students
      io.emit("all-buses", getActiveBuses());
      
      // Send updated stops back to the driver
      io.to(`driver-${driverEmail}`).emit("my-stops", busStops[driverEmail]);
    }
  });

  // ✅ UPDATE CURRENT STOP
  socket.on("set-current-stop", (data) => {
    if (!data || !data.driverEmail || data.stopIndex == null) return;

    const { driverEmail, stopIndex } = data;

    if (buses[driverEmail]) {
      buses[driverEmail].currentStopIndex = stopIndex;
      console.log(`📍 Current stop updated for ${driverEmail}: ${stopIndex}`);
      io.emit("all-buses", getActiveBuses());
    }
  });

  // Driver stops tracking
  socket.on("driver-stop", (data) => {
    if (!data || !data.driverEmail) return;

    const { driverEmail } = data;

    if (buses[driverEmail] && buses[driverEmail].socketId === socket.id) {
      buses[driverEmail].active = false;
      buses[driverEmail].socketId = null;
      console.log(`⛔ Driver stopped: ${driverEmail}`);

      // Broadcast updated list to all students
      io.emit("all-buses", getActiveBuses());
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);

    // Find and deactivate any bus associated with this socket
    for (const email in buses) {
      if (buses[email].socketId === socket.id) {
        buses[email].active = false;
        buses[email].socketId = null;
        console.log(`🔌 Auto-stopped bus for: ${email}`);
      }
    }

    // Broadcast updated list
    io.emit("all-buses", getActiveBuses());
  });
});

// ✅ AUTO-OPEN BROWSER ON SERVER START
function openBrowser(url) {
  const platform = process.platform;
  let command;

  switch (platform) {
    case 'win32':
      command = `start "" "${url}"`;
      break;
    case 'darwin':
      command = `open "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      console.log("⚠️ Could not open browser automatically. Please open manually:", url);
    } else {
      console.log("🌐 Browser opened automatically!");
    }
  });
}

server.listen(PORT, "0.0.0.0", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n🚀 Server running at ${url}`);
  console.log(`📡 Socket.IO ready for connections\n`);
  
  // Auto-open browser after small delay
  setTimeout(() => openBrowser(url), 1000);
});