require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const Razorpay = require("razorpay");

const app = express();
const port = process.env.PORT || 3000;

// -------------------------
// Razorpay
// -------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// -------------------------
// Database
// -------------------------
const db = new Database(path.join(__dirname, "appointments.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    service TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    amount INTEGER NOT NULL,
    payment_id TEXT,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, time)
  )
`);

// -------------------------
// Middleware
// -------------------------
app.use(express.json());

// Serve files from public folder
app.use(express.static(path.join(__dirname, "public")));

// -------------------------
// Services
// -------------------------
const services = {
  "Hair Cut": 350,
  "Facial": 800,
  "Spa": 1200,
  "Cosmetic Products": 0
};

// -------------------------
// Homepage
// -------------------------
app.get("/", (req, res) => {
  res.send("HELLO - SERVER IS WORKING");
});

// -------------------------
// Payment test page
// -------------------------
app.get("/payment", (req, res) => {
  res.send("Payment page");
});

// -------------------------
// Configuration
// -------------------------
app.get("/api/config", (req, res) => {
  res.json({
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    businessPhone: process.env.BUSINESS_PHONE || ""
  });
});

// -------------------------
// Available slots
// -------------------------
app.get("/api/slots", (req, res) => {
  const date = String(req.query.date || "");

  if (!date) {
    return res.status(400).json({
      error: "Date is required."
    });
  }

  const rows = db
    .prepare(`
      SELECT time
      FROM appointments
      WHERE date = ?
      AND payment_status IN ('paid', 'pending')
    `)
    .all(date);

  res.json({
    booked: rows.map(row => row.time)
  });
});

// -------------------------
// Create Razorpay order
// -------------------------
app.post("/api/create-order", async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      service,
      date,
      time
    } = req.body;

    if (!name || !phone || !service || !date || !time) {
      return res.status(400).json({
        error: "Please fill all required fields."
      });
    }

    if (!services[service]) {
      return res.status(400).json({
        error: "Invalid service."
      });
    }

    const amount = services[service];

    if (!amount) {
      return res.status(400).json({
        error: "This item is not bookable."
      });
    }

    // Check if slot already booked
    const existing = db
      .prepare(`
        SELECT id
        FROM appointments
        WHERE date = ?
        AND time = ?
        AND payment_status IN ('paid', 'pending')
      `)
      .get(date, time);

    if (existing) {
      return res.status(409).json({
        error: "That time slot is already reserved. Please choose another."
      });
    }

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `phbs_${Date.now()}`,
      notes: {
        service,
        date,
        time,
        customer: name
      }
    });

    // Save appointment
    const result = db
      .prepare(`
        INSERT INTO appointments
        (
          name,
          phone,
          email,
          service,
          date,
          time,
          amount,
          payment_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `)
      .run(
        name,
        phone,
        email || "",
        service,
        date,
        time,
        amount
      );

    res.json({
      orderId: order.id,
      amount: amount * 100,
      appointmentId: result.lastInsertRowid
    });

  } catch (err) {
    console.error("Create order error:", err);

    res.status(500).json({
      error: "Could not create payment order. Check Razorpay configuration."
    });
  }
});

// -------------------------
// Verify Razorpay payment
// -------------------------
app.post("/api/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      appointmentId
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !appointmentId
    ) {
      return res.status(400).json({
        error: "Missing payment details."
      });
    }

    const expectedSignature = crypto
      .createHmac(
        "sha256",
        process.env.RAZORPAY_KEY_SECRET || ""
      )
      .update(
        `${razorpay_order_id}|${razorpay_payment_id}`
      )
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      db.prepare(`
        UPDATE appointments
        SET payment_status = 'failed'
        WHERE id = ?
      `).run(appointmentId);

      return res.status(400).json({
        error: "Payment verification failed."
      });
    }

    db.prepare(`
      UPDATE appointments
      SET payment_status = 'paid',
          payment_id = ?
      WHERE id = ?
    `).run(
      razorpay_payment_id,
      appointmentId
    );

    const appointment = db
      .prepare(`
        SELECT *
        FROM appointments
        WHERE id = ?
      `)
      .get(appointmentId);

    res.json({
      success: true,
      appointment
    });

  } catch (err) {
    console.error("Payment verification error:", err);

    res.status(500).json({
      error: "Payment verification failed."
    });
  }
});
app.post("/api/book-appointment", (req, res) => {

  try {

    const {
      name,
      phone,
      email,
      service,
      date,
      time
    } = req.body;


    if (
      !name ||
      !phone ||
      !service ||
      !date ||
      !time
    ) {

      return res.status(400).json({
        error:
          "Please fill all required fields."
      });

    }


    // Check if slot is already booked

    const existing =
      db.prepare(`
        SELECT id
        FROM appointments
        WHERE date = ?
        AND time = ?
        AND payment_status = 'booked'
      `).get(date, time);


    if (existing) {

      return res.status(409).json({
        error:
          "This time slot is already booked. Please choose another time."
      });

    }


    // Get service price
    // Price is stored for record purposes only.
    // Customer does NOT pay online.

    const amount =
      services[service] || 0;


    const result =
      db.prepare(`
        INSERT INTO appointments
        (
          name,
          phone,
          email,
          service,
          date,
          time,
          amount,
          payment_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'booked')
      `).run(
        name,
        phone,
        email || "",
        service,
        date,
        time,
        amount
      );


    res.json({

      success: true,

      appointmentId:
        result.lastInsertRowid,

      message:
        "Appointment booked successfully."

    });


  } catch (err) {

    console.error(
      "Booking error:",
      err
    );


    res.status(500).json({

      error:
        "Could not book appointment."

    });

  }

});


// -------------------------
// Start server
// -------------------------
app.listen(port, () => {
  console.log("");
  console.log("=================================");
  console.log(" Server started successfully!");
  console.log("=================================");
  console.log(` Website: http://localhost:${port}`);
  console.log(` Payment: http://localhost:${port}/payment`);
  console.log("=================================");
  console.log("");
});
