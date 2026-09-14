import { autonomousCommand } from "../../autonomous/daemon.ts";

const command = (["start", "status", "pause", "resume", "stop"] as const).find((action) => action === process.argv[2]);
if (!command) throw new Error("Fixture requires an explicit control action");
await autonomousCommand(command, {
	expectedScope: {
		mode: "paper",
		exchange: "binance",
		marketType: "spot",
		quoteCurrency: "USDT",
		positionMode: "one-way",
		accountId: "fixture",
	},
	output: (output) => console.log(JSON.stringify({ output })),
	onStatus: (status) => console.log(JSON.stringify({ status })),
});
