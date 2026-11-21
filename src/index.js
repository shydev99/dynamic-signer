import {
  createMeeClient,
  toMultichainNexusAccount,
  getMEEVersion,
  MEEVersion,
  getMeeScanLink,
} from "@biconomy/abstractjs";
import {
  http,
  parseAbi,
  parseUnits,
  createPublicClient,
  maxUint256,
  maxUint160,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { validate } from "@tma.js/init-data-node";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RECIPIENT = "0xE5095C4d3409726F61Df1F69f295Ab6A95CF905C";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const SESSION_TTL = 30 * 24 * 60 * 60;

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);

const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
]);

const PERMIT2_TYPES = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
};

function jsonError(status, message) {
  return Response.json({ ok: false, error: message }, { status });
}

function safeParse(raw) {
  if (!raw) return null;
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try { return JSON.parse(clean); } catch { return null; }
}

function parseInitData(raw) {
  const params = new URLSearchParams(raw);
  const userJson = params.get("user");
  if (!userJson) return {};
  try { return { user: JSON.parse(userJson) }; } catch { return {}; }
}

async function setPendingInput(env, chatId, kind) {
  await env.PAYMENT_STATE.put(`pending_input:${chatId}`, kind, { expirationTtl: 300 });
}
async function getPendingInput(env, chatId) {
  return env.PAYMENT_STATE.get(`pending_input:${chatId}`);
}
async function clearPendingInput(env, chatId) {
  await env.PAYMENT_STATE.delete(`pending_input:${chatId}`);
}

function sessionKey(chatId, sessionId) {
  return `session:${chatId}:${sessionId}`;
}
function sessionPrefix(chatId) {
  return `session:${chatId}:`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname.startsWith("/index.html")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/auth/telegram" && request.method === "POST") {
      const { handleTelegramAuth } = await import("./auth.js");
      return handleTelegramAuth(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      const [authType, authData = ""] = (request.headers.get("authorization") || "").split(" ");
      if (authType !== "tma") return jsonError(401, "Unauthorized");

      let parsedInitData;
      try {
        validate(authData, env.TELEGRAM_BOT_TOKEN, { expiresIn: 3600 });
        parsedInitData = parseInitData(authData);
      } catch (e) {
        return jsonError(401, e.message || "Invalid initData");
      }

      const userId = parsedInitData.user?.id;
      if (!userId) return jsonError(401, "No user in initData");

      // GET /api/sessions
      if (url.pathname === "/api/sessions" && request.method === "GET") {
        const list = await env.PAYMENT_STATE.list({ prefix: sessionPrefix(userId) });
        const sessions = [];
        for (const k of list.keys) {
          const raw = await env.PAYMENT_STATE.get(k.name);
          const s = safeParse(raw);
          if (s) sessions.push({
            sessionId: s.sessionId,
            amount: s.amount ?? null,
            recipient: s.recipient ?? RECIPIENT,
            deadline: s.deadline || s.expiration,
            status: s.status,
          });
        }
        sessions.sort((a, b) => String(b.sessionId).localeCompare(String(a.sessionId)));
        return Response.json({ sessions });
      }

      // POST /api/permit-data — frontend passes its EVM address, backend builds Permit2 typed data
      if (url.pathname === "/api/permit-data" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const owner = body.owner; // EVM address from frontend (TMAWallet or user's own wallet)
        if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner)) {
          return jsonError(400, "Missing or invalid owner address");
        }

        const publicClient = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });
        const { account } = await buildMeeClient(env);
        const spender = account.addressOn(base.id);

        // Check USDC allowance to Permit2 (frontend should have approved already, or needs to)
        const allowance = await publicClient.readContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner, PERMIT2],
        });

        if (allowance < maxUint160) {
          // Frontend needs to approve Permit2 first; return a flag
          return Response.json({
            needsApproval: true,
            permit2Address: PERMIT2,
            usdcAddress: USDC,
            owner,
          });
        }

        // Read current Permit2 nonce
        const permit2Allowance = await publicClient.readContract({
          address: PERMIT2,
          abi: permit2Abi,
          functionName: "allowance",
          args: [owner, USDC, spender],
        });
        const nonce = Number(permit2Allowance[2]);

        const expiration = Math.floor(Date.now() / 1000) + SESSION_TTL;
        const sigDeadline = expiration;

        const typedData = {
          domain: { name: "Permit2", chainId: base.id, verifyingContract: PERMIT2 },
          types: PERMIT2_TYPES,
          primaryType: "PermitSingle",
          message: {
            details: { token: USDC, amount: maxUint160, expiration, nonce },
            spender,
            sigDeadline,
          },
        };

        const sessionId = `s${Date.now()}`;
        const session = {
          sessionId,
          chatId: userId,
          owner,
          spender,
          nonce,
          expiration,
          sigDeadline,
          status: "pending_signature",
        };
        await env.PAYMENT_STATE.put(sessionKey(userId, sessionId), JSON.stringify(session), {
          expirationTtl: SESSION_TTL,
        });

        return Response.json({ sessionId, typedData, owner, spender });
      }

      // POST /api/signature — frontend signs via its EVM wallet, sends v/r/s
      if (url.pathname === "/api/signature" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const sessionId = String(body.sessionId || "").trim();
        const v = String(body.v || "").trim();
        const r = String(body.r || "").trim();
        const s = String(body.s || "").trim();

        if (!sessionId || !v || !r || !s) {
          return jsonError(400, "Missing sessionId, v, r, or s");
        }

        const key = sessionKey(userId, sessionId);
        const raw = await env.PAYMENT_STATE.get(key);
        const session = safeParse(raw);
        if (!session || session.status !== "pending_signature") {
          return jsonError(409, "Session not awaiting signature");
        }

        session.v = v;
        session.r = r;
        session.s = s;
        session.status = "active";
        await env.PAYMENT_STATE.put(key, JSON.stringify(session), { expirationTtl: SESSION_TTL });

        return Response.json({ ok: true, sessionId, status: "active" });
      }

      // POST /api/charge — Permit2.permit + Permit2.transferFrom via MEE
      if (url.pathname === "/api/charge" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const sessionId = String(body.sessionId || "").trim();
        const amountStr = String(body.amount || "").trim();
        if (!sessionId || !amountStr) return jsonError(400, "Missing sessionId or amount");

        let amount;
        try { amount = parseUnits(amountStr, 6); } catch { return jsonError(400, "Invalid amount"); }
        if (amount <= 0n) return jsonError(400, "Amount must be > 0");

        const key = sessionKey(userId, sessionId);
        const raw = await env.PAYMENT_STATE.get(key);
        const session = safeParse(raw);
        if (!session || session.status !== "active") return jsonError(409, "Session not active");
        if (session.expiration * 1000 < Date.now()) return jsonError(410, "Permit expired");

        const { account, meeClient } = await buildMeeClient(env);

        const signatureHex = "0x" + session.r.slice(2) + session.s.slice(2) + Number(session.v).toString(16).padStart(2, "0");

        const permitInstruction = await account.buildComposable({
          type: "default",
          data: {
            chainId: base.id,
            to: PERMIT2,
            abi: permit2Abi,
            functionName: "permit",
            args: [
              session.owner,
              {
                details: { token: USDC, amount: maxUint160, expiration: session.expiration, nonce: session.nonce },
                spender: session.spender,
                sigDeadline: session.sigDeadline,
              },
              signatureHex,
            ],
          },
        });

        const transferInstruction = await account.buildComposable({
          type: "default",
          data: {
            chainId: base.id,
            to: PERMIT2,
            abi: permit2Abi,
            functionName: "transferFrom",
            args: [session.owner, RECIPIENT, amount, USDC],
          },
        });

        try {
          await executeAndReport(env, userId, account, meeClient, [permitInstruction, transferInstruction]);
          return Response.json({ ok: true, sessionId, amount: amountStr });
        } catch (e) {
          console.error("charge error:", e.message);
          return Response.json({ ok: false, error: e.message }, { status: 500 });
        }
      }

      return jsonError(404, "Not found");
    }

    // ---------- Telegram webhook (unchanged) ----------
    if (url.pathname !== "/telegram" || request.method !== "POST") return new Response("Not found", { status: 404 });

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

    const update = await request.json();

    if (update.callback_query) {
      const cq = update.callback_query;
      const cqChatId = cq.message.chat.id;
      const data = cq.data;

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });

      try {
        if (data === "balance") await sendTelegram(env, cqChatId, await formatBalance(env, cqChatId));
        else if (data === "newsession") { await setPendingInput(env, cqChatId, "newsession"); await sendTelegram(env, cqChatId, "Send the amount in USDC:\n\nExample:\n0.05"); }
        else if (data === "sessions") await listSessions(env, cqChatId);
        else if (data === "help") await sendMenu(env, cqChatId);
        else if (data.startsWith("exec:")) await sendTelegram(env, cqChatId, "Manual execution disabled. Use /api/charge.");
        else await sendTelegram(env, cqChatId, "Unknown button.");
      } catch (err) {
        console.error("callback error:", err.stack || err.message);
        await sendTelegram(env, cqChatId, `Error: ${err.message}`);
      }

      return new Response("ok");
    }

    const rawText = update?.message?.text ?? "";
    const text = rawText.replace(/@\w+$/, "").trim();
    const chatId = update?.message?.chat?.id;
    if (!chatId) return new Response("ok");

    try {
      const pending = await getPendingInput(env, chatId);
      if (pending === "newsession") {
        await clearPendingInput(env, chatId);
        if (!text.startsWith("/")) {
          const amountStr = text.trim();
          if (!amountStr) { await sendTelegram(env, chatId, "Send the amount. Example:\n0.05"); return new Response("ok"); }
          await sendTelegram(env, chatId, "Server-signed sessions are disabled. Use the Mini App to sign Permit2.");
          return new Response("ok");
        }
      }

      if (text === "/help" || text === "/start") { await sendMenu(env, chatId); return new Response("ok"); }
      if (text === "/balance") { await sendTelegram(env, chatId, await formatBalance(env, chatId)); return new Response("ok"); }
      if (text === "/sessions") { await listSessions(env, chatId); return new Response("ok"); }
      if (text.startsWith("/execute")) { await sendTelegram(env, chatId, "Manual execution disabled. Use /api/charge."); return new Response("ok"); }
      if (text.startsWith("/newsession")) { await sendTelegram(env, chatId, "Server-signed sessions are disabled. Use the Mini App to sign Permit2."); return new Response("ok"); }

      await sendTelegram(env, chatId, "Unknown command. Try /help");
    } catch (err) {
      console.error("handler error:", err.stack || err.message);
      await sendTelegram(env, chatId, `Error: ${err.message}`);
    }

    return new Response("ok");
  },
};

async function listSessions(env, chatId) {
  const list = await env.PAYMENT_STATE.list({ prefix: sessionPrefix(chatId) });
  if (list.keys.length === 0) { await sendTelegram(env, chatId, "No sessions found."); return; }

  const rows = [];
  for (const k of list.keys) {
    const raw = await env.PAYMENT_STATE.get(k.name);
    const s = safeParse(raw);
    if (s) rows.push(s);
  }
  rows.sort((a, b) => String(b.sessionId).localeCompare(String(a.sessionId)));

  const lines = [];
  const buttons = [];
  for (const s of rows) {
    const amtLabel = s.amount ? `${(Number(s.amount) / 1e6).toFixed(6)} USDC` : "unlimited";
    lines.push(`ID: ${s.sessionId}\nAmount: ${amtLabel}\nTo: ${s.recipient ?? RECIPIENT}\nStatus: ${s.status}`);
    if (s.status === "pending") buttons.push([{ text: `Execute ${s.sessionId}`, callback_data: `exec:${s.sessionId}` }]);
  }

  const body = { chat_id: chatId, text: lines.join("\n\n") };
  if (buttons.length > 0) body.reply_markup = { inline_keyboard: buttons.slice(0, 20) };

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function formatBalance(env, chatId) {
  const list = await env.PAYMENT_STATE.list({ prefix: sessionPrefix(chatId) });
  if (list.keys.length === 0) return "No active sessions.";

  const lines = [];
  for (const k of list.keys) {
    const raw = await env.PAYMENT_STATE.get(k.name);
    const s = safeParse(raw);
    if (!s) continue;
    const amtLabel = s.amount ? `${(Number(s.amount) / 1e6).toFixed(6)} USDC` : "unlimited";
    const exp = new Date(Number(s.deadline || s.expiration) * 1000).toISOString();
    lines.push(`ID: ${s.sessionId}\nAmount: ${amtLabel}\nTo: ${s.recipient ?? RECIPIENT}\nExpires: ${exp}\nStatus: ${s.status}`);
  }

  return lines.length > 0 ? lines.join("\n\n") : "No active sessions.";
}

async function sendMenu(env, chatId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Choose an action:",
      reply_markup: { inline_keyboard: [
        [{ text: "Balance", callback_data: "balance" }],
        [{ text: "Sessions", callback_data: "sessions" }],
        [{ text: "New Session", callback_data: "newsession" }],
        [{ text: "Help", callback_data: "help" }],
      ]},
    }),
  });
}

async function buildMeeClient(env) {
  const signer = privateKeyToAccount(env.PROCESSING_PRIVATE_KEY);
  const account = await toMultichainNexusAccount({
    signer,
    chainConfigurations: [{ chain: base, transport: http(env.BASE_RPC_URL), version: getMEEVersion(MEEVersion.V2_2_3) }],
  });
  const meeClient = await createMeeClient({ account });
  return { account, meeClient };
}

async function executeAndReport(env, chatId, account, meeClient, instructions) {
  const quote = await meeClient.getQuote({ instructions, feeToken: { address: USDC, chainId: base.id } });
  const { hash } = await meeClient.executeQuote({ quote });
  await sendTelegram(env, chatId, `Submitted.\nTrack: ${getMeeScanLink(hash)}\nGas fee: ${quote.paymentInfo.tokenAmount} USDC`);

  let receipt;
  try { receipt = await meeClient.getSupertransactionReceipt({ hash }); }
  catch { await sendTelegram(env, chatId, `Status unknown. Check: ${getMeeScanLink(hash)}`); return; }

  if (receipt.transactionStatus === "MINED_SUCCESS") {
    const txHash = receipt.userOps?.[0]?.transactionHash;
    await sendTelegram(env, chatId, txHash ? `Confirmed: https://basescan.org/tx/${txHash}` : "Confirmed.");
  } else {
    await sendTelegram(env, chatId, `Status: ${receipt.transactionStatus}. Check: ${getMeeScanLink(hash)}`);
  }
}

async function sendTelegram(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}