import express from "express";
import { DynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";

const app = express();
app.use(express.json());

const client = new DynamicEvmWalletClient({
  environmentId: process.env.DYNAMIC_ENVIRONMENT_ID,
});

app.use(async (req, res, next) => {
  try {
    await client.authenticateApiToken(process.env.DYNAMIC_API_TOKEN);
    next();
  } catch (e) {
    res.status(401).json({ error: "Auth failed: " + e.message });
  }
});

app.post("/create-wallet", async (req, res) => {
  try {
    const { walletMetadata, externalServerKeyShares } = await client.createWalletAccount({
      thresholdSignatureScheme: "TWO_OF_TWO",
      password: process.env.DYNAMIC_WALLET_PASSWORD,
      backUpToDynamic: true,
    });
    res.json({
      address: walletMetadata.accountAddress,
      walletMetadata,
      externalServerKeyShares,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/sign-typed-data", async (req, res) => {
  try {
    const { walletMetadata, externalServerKeyShares, typedData } = req.body;
    const signature = await client.signTypedData({
      walletMetadata,
      typedData,
      externalServerKeyShares,
      password: process.env.DYNAMIC_WALLET_PASSWORD,
    });
    res.json({ signature });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Dynamic signer running on port " + PORT);
});
