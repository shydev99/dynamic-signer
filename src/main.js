import { TMAWalletClient } from "@tmawallet/sdk";
import { TMAWalletEVM } from "@tmawallet/sdk/dist/wallets/TMAWallet.EVM";
import { ethers } from "ethers";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

// Replace with your TMAWallet API Key (from dash.tmawallet.com)
const TMAWALLET_API_KEY = "YOUR_TMAWALLET_API_KEY";

const client = new TMAWalletClient(TMAWALLET_API_KEY);
const evmWallet = new TMAWalletEVM(client);

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");

const signBtn = document.getElementById("sign");
const statusEl = document.getElementById("status");
let signer = null;
let evmAddress = null;

function setStatus(msg, kind) {
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.textContent = msg;
}

// Initialize TMAWallet on page load (create or restore EVM wallet)
async function initWallet() {
  try {
    setStatus("Initializing wallet…");
    await evmWallet.authenticate();
    evmAddress = evmWallet.walletAddress;
    signer = evmWallet.getEthersSigner(provider);
    signBtn.disabled = false;
    setStatus("EVM Wallet: " + evmAddress.slice(0, 6) + "…" + evmAddress.slice(-4), "ok");
  } catch (e) {
    setStatus("Wallet init failed: " + (e.message || String(e)), "error");
  }
}

initWallet();

signBtn.onclick = async () => {
  if (!signer || !evmAddress) return;
  signBtn.disabled = true;
  try {
    setStatus("Preparing Permit2 signature…");

    // 1. Request Permit2 typed data from backend (passing the TMAWallet address)
    const res = await fetch("/api/permit-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: evmAddress }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "permit-data failed");

    // 2. If backend indicates approval is needed, execute USDC.approve(Permit2, max) first
    if (data.needsApproval) {
      setStatus("Approving Permit2…");
      const usdcAbi = ["function approve(address spender, uint256 amount) returns (bool)"];
      const usdcContract = new ethers.Contract(data.usdcAddress, usdcAbi, signer);
      const tx = await usdcContract.approve(data.permit2Address, ethers.MaxUint256);
      await tx.wait();
      setStatus("Approval confirmed. Re-requesting permit data…");

      // Re-request permit-data (allowance is now set)
      const res2 = await fetch("/api/permit-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: evmAddress }),
      });
      const data2 = await res2.json();
      if (!res2.ok) throw new Error(data2.error || "permit-data failed after approval");
      Object.assign(data, data2);
    }

    // 3. Sign Permit2 typed data
    setStatus("Signing Permit2…");
    const { domain, types, message } = data.typedData;

    // Remove EIP712Domain from types (ethers.js v6 requires it to be inferred automatically)
    const cleanTypes = { ...types };
    delete cleanTypes.EIP712Domain;

    const signature = await signer.signTypedData(domain, cleanTypes, message);

    // 4. Split signature into v/r/s and submit to backend
    const sig = ethers.Signature.from(signature);
    setStatus("Submitting signature…");

    const saveRes = await fetch("/api/signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: data.sessionId,
        v: sig.v,
        r: sig.r,
        s: sig.s,
      }),
    });
    const saveData = await saveRes.json();
    if (!saveRes.ok) throw new Error(saveData.error || "signature save failed");

    setStatus("Permit2 signed and saved. Session: " + data.sessionId, "ok");
  } catch (e) {
    setStatus(e.message || String(e), "error");
  } finally {
    signBtn.disabled = !signer;
  }
};