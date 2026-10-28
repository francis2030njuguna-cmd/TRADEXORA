const express = require("express");
const axios = require("axios");

const router = express.Router();

const PAYHERO_BASE_URL = "https://backend.payhero.co.ke/api/v2";

const {
    PAYHERO_API_USERNAME,
    PAYHERO_API_PASSWORD,
    PAYHERO_CHANNEL_ID
} = process.env;

if (!PAYHERO_API_USERNAME || !PAYHERO_API_PASSWORD || !PAYHERO_CHANNEL_ID) {
    console.warn("⚠️ PayHero credentials missing. Set PAYHERO_API_USERNAME, PAYHERO_API_PASSWORD and PAYHERO_CHANNEL_ID in .env");
}

// In-memory transaction store (use a DB in production)
const transactions = new Map();

// Basic phone sanity check: 2547XXXXXXXX or 2541XXXXXXXX
function isValidKenyanPhone(phone) {
    return typeof phone === "string" && /^254(7|1)\d{8}$/.test(phone);
}

router.post("/stk-push", async(req, res) => {
    try {
        const { phone_number, amount } = req.body;

        if (!phone_number || !amount) {
            return res.status(400).json({
                success: false,
                message: "Phone number and amount are required"
            });
        }

        const phone = String(phone_number).replace(/\D/g, "");
        if (!isValidKenyanPhone(phone)) {
            return res.status(400).json({
                success: false,
                message: "Invalid phone number. Use format 2547XXXXXXXX or 2541XXXXXXXX."
            });
        }

        const numericAmount = Number(amount);
        if (!Number.isInteger(numericAmount) || numericAmount < 1) {
            return res.status(400).json({
                success: false,
                message: "Amount must be a positive whole number (KES)."
            });
        }

        const externalReference = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

        const payload = {
            amount: numericAmount,
            phone_number: phone,
            channel_id: PAYHERO_CHANNEL_ID,
            provider: "m-pesa",
            external_reference: externalReference,
            callback_url: process.env.PAYHERO_CALLBACK_URL || "https://yourdomain.com/api/payhero/payhero-callback",
            metadata: { source: "tradexora-deposit" }
        };

        const response = await axios.post(
            `${PAYHERO_BASE_URL}/payments`,
            payload, {
                auth: {
                    username: PAYHERO_API_USERNAME,
                    password: PAYHERO_API_PASSWORD
                },
                timeout: 30000
            }
        );

        transactions.set(externalReference, {
            phone,
            amount: numericAmount,
            status: "PENDING",
            order_tracking_id: response.data.order_tracking_id || null,
            createdAt: new Date().toISOString()
        });

        console.log(`STK push queued | ref=${externalReference} | phone=${phone} | amount=${numericAmount}`);

        return res.json({
            success: true,
            message: "STK Push sent successfully. Check your phone and enter your M-Pesa PIN.",
            data: {
                external_reference: externalReference,
                order_tracking_id: response.data.order_tracking_id || null,
                status: response.data.status || "PENDING"
            }
        });

    } catch (error) {
        const status = error.response ? error.response.status : 500;
        const errorMessage =
            error.response &&
            error.response.data &&
            (error.response.data.message || error.response.data.errorMessage);

        console.error("STK ERROR:", errorMessage || error.message);

        return res.status(status === 400 ? 400 : 500).json({
            success: false,
            message: errorMessage || "Payment initiation failed"
        });
    }
});

// Frontend polls this to check payment status
router.get("/status/:reference", (req, res) => {
    const txn = transactions.get(req.params.reference);
    if (!txn) {
        return res.status(404).json({ success: false, message: "Transaction not found" });
    }
    return res.json({ success: true, data: txn });
});

router.post("/payhero-callback", async(req, res) => {
    console.log("PayHero Callback:", JSON.stringify(req.body));

    try {
        const callback = req.body;
        const data = callback.ResponseCode !== undefined ? callback : (callback.Body && callback.Body.stkCallback) || callback;

        // Resolve the transaction reference from the callback
        const ref = data.external_reference || (callback.external_reference) || null;

        const resultCode = data.ResultCode;
        const status = resultCode === 0 || data.status === "SUCCESS" ? "SUCCESS" : "FAILED";

        if (ref && transactions.has(ref)) {
            transactions.get(ref).status = status;
            transactions.get(ref).completedAt = new Date().toISOString();
            console.log(`Transaction ${ref} marked ${status}`);
        }

        // TODO: credit the user's balance in your DB here when status === "SUCCESS"

        res.sendStatus(200);
    } catch (err) {
        console.error("Callback processing error:", err.message);
        res.sendStatus(200);
    }
});

module.exports = router;