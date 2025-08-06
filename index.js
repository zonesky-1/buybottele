require("dotenv").config();
const { Telegraf, session } = require("telegraf");
const {
  handleBuy,
  handleProductSelected,
  handleWaitUpload,
  handlePaymentProof,
  handleApprove,
  handleReject,
  handleDeploy,
  handleStatus,
  handleHistory
} = require("./handlers/buyHandler");

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

bot.command("buy", handleBuy);
bot.command("status", handleStatus);
bot.command("history", handleHistory);
bot.action(/buy_(.+)/, ctx => handleProductSelected(ctx, ctx.match[1]));
bot.action("wait_upload_bukti", handleWaitUpload);
bot.on("photo", handlePaymentProof);
bot.action(/approve_(\d+)/, ctx => handleApprove(ctx, ctx.match[1]));
bot.action(/reject_(\d+)/, ctx => handleReject(ctx, ctx.match[1]));
bot.on("text", handleDeploy);

bot.launch().then(() => console.log("🤖 Bot aktif di Railway"));
