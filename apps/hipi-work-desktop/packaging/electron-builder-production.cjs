const path = require("node:path");
const base = require("./electron-builder.cjs");
const { productionBuilderConfig, productionPolicy } = require("../scripts/production-policy.mjs");

module.exports = productionBuilderConfig(
	base,
	productionPolicy(process.platform, process.arch, process.env),
	path.join(__dirname, "entitlements.production.mac.plist"),
);
