const { Markup } = require("telegraf");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const archiver = require("archiver");

const OWNER_ID = process.env.OWNER_ID;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const DB_PATH = path.join(__dirname, "../lib/database");
const SOURCE_FOLDER = path.join(__dirname, "../sources");

function getTransactions() {
  const file = path.join(DB_PATH, "transactions.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
}
function saveTransactions(data) {
  const file = path.join(DB_PATH, "transactions.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function saveTransaction(tx) {
  const all = getTransactions();
  all.push(tx);
  saveTransactions(all);
}

async function handleBuy(ctx) {
  const sources = await fs.readdir(SOURCE_FOLDER);
  if (!sources.length) return ctx.reply("❌ Tidak ada produk tersedia.");
  const buttons = sources.map(name => [Markup.button.callback(name, `buy_${name}`)]);
  await ctx.reply("🛍️ Pilih produk yang ingin dibeli:", Markup.inlineKeyboard(buttons));
}

async function handleProductSelected(ctx, product) {
  ctx.session.selectedProduct = product;
  ctx.session.awaitingPaymentProof = true;
  await ctx.editMessageText(`🛒 Produk: *${product}*\n💳 Harga: Rp10.000\n\nSilakan bayar ke QR DANA berikut dan kirim bukti pembayaran berupa foto/screenshot:`, {
    parse_mode: "Markdown"
  });

  await ctx.reply("📲 Klik link berikut untuk bayar via DANA:\n\n👉 https://link.dana.id/minta?full_url=https://qr.dana.id/v1/281012012022040108863297", {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("✅ Sudah Bayar", "wait_upload_bukti")]
    ])
  });
}

async function handleWaitUpload(ctx) {
  ctx.session.awaitingPaymentProof = true;
  await ctx.reply("📸 Silakan kirim bukti pembayaran sekarang (foto atau screenshot).");
}

async function handlePaymentProof(ctx) {
  if (!ctx.session?.awaitingPaymentProof) return;

  const fileId = ctx.message.photo.at(-1).file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const buyerId = ctx.from.id;
  const buyerName = ctx.from.first_name;
  const product = ctx.session.selectedProduct;

  ctx.session.awaitingPaymentProof = false;
  ctx.session.pendingPayment = { buyerId, buyerName, product, proofUrl: fileLink.href };

  saveTransaction({
    buyerId,
    buyerName,
    product,
    proofUrl: fileLink.href,
    status: "waiting"
  });

  await ctx.reply("📤 Bukti pembayaran terkirim ke Owner. Tunggu konfirmasi...");

  await ctx.telegram.sendPhoto(OWNER_ID, fileLink.href, {
    caption: `💰 Permintaan Pembelian\n👤 Dari: ${buyerName} (${buyerId})\n📦 Produk: ${product}`,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("✅ Terima", `approve_${buyerId}`)],
      [Markup.button.callback("❌ Tolak", `reject_${buyerId}`)]
    ])
  });
}

async function handleApprove(ctx, buyerId) {
  const transactions = getTransactions();
  const tx = transactions.find(t => t.buyerId == buyerId && t.status === "waiting");
  if (tx) {
    tx.status = "approved";
    saveTransactions(transactions);
    await ctx.telegram.sendMessage(buyerId, "✅ Pembayaran dikonfirmasi!\nSilakan kirim nama project/domain yang kamu inginkan (tanpa spasi, maksimal 32 karakter).");
  }
}

async function handleReject(ctx, buyerId) {
  const transactions = getTransactions();
  const tx = transactions.find(t => t.buyerId == buyerId && t.status === "waiting");
  if (tx) {
    tx.status = "rejected";
    saveTransactions(transactions);
    await ctx.telegram.sendMessage(buyerId, "❌ Maaf, bukti pembayaran kamu ditolak.");
  }
}

async function handleDeploy(ctx) {
  if (!ctx.session?.pendingPayment) return;
  const name = ctx.message.text.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9-]{1,32}$/.test(name)) return ctx.reply("❌ Nama domain tidak valid.");

  const { product, buyerName } = ctx.session.pendingPayment;
  const sourcePath = path.join(SOURCE_FOLDER, product);
  const tempDir = path.join(__dirname, `../tmp_${ctx.from.id}`);
  const zipPath = path.join(__dirname, `../${name}.zip`);
  await ctx.reply(`🚀 Membuat website dari *${product}* dan deploy ke Vercel...`, { parse_mode: "Markdown" });

  try {
    await fs.copy(sourcePath, tempDir);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(tempDir, false);
      archive.finalize();
    });

    const res = await axios.post("https://api.vercel.com/v13/deployments", fs.createReadStream(zipPath), {
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        "Content-Type": "application/zip"
      },
      maxBodyLength: Infinity
    });

    const url = `https://${res.data.url}`;
    await ctx.reply(`✅ Website berhasil dideploy!\n🌐 ${url}`);
    await ctx.telegram.sendMessage(OWNER_ID, `🆕 Website baru berhasil dideploy oleh ${buyerName}\n🌐 ${url}`);

  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Gagal deploy.");
  } finally {
    await fs.remove(tempDir).catch(() => {});
    await fs.remove(zipPath).catch(() => {});
    ctx.session.deployReady = false;
  }
}

async function handleStatus(ctx) {
  const buyerId = ctx.from.id;
  const transactions = getTransactions().filter(t => t.buyerId === buyerId);
  if (!transactions.length) return ctx.reply("❌ Tidak ada transaksi ditemukan.");
  let msg = "🛒 Riwayat Pembelian Anda:\n";
  transactions.forEach((tx, i) => {
    msg += `\n${i + 1}. *${tx.product}*\nStatus: ${tx.status}\n[Bukti](${tx.proofUrl})\n`;
  });
  await ctx.reply(msg, { parse_mode: "Markdown" });
}

async function handleHistory(ctx) {
  if (ctx.from.id != OWNER_ID) return ctx.reply("❌ Hanya Owner.");
  const transactions = getTransactions();
  if (!transactions.length) return ctx.reply("❌ Tidak ada histori.");
  let msg = "📜 Semua Transaksi:\n";
  transactions.forEach((tx, i) => {
    msg += `\n${i + 1}. *${tx.product}* oleh ${tx.buyerName} (${tx.buyerId})\nStatus: ${tx.status}\n[Bukti](${tx.proofUrl})\n`;
  });
  await ctx.reply(msg, { parse_mode: "Markdown" });
}

module.exports = {
  handleBuy,
  handleProductSelected,
  handleWaitUpload,
  handlePaymentProof,
  handleApprove,
  handleReject,
  handleDeploy,
  handleStatus,
  handleHistory
};
