import { Plugin, Messenger } from "@telecraft/types";

import { EventEmitter } from "events";

// Telegraf
import { Telegraf, Middleware, Context } from "telegraf";
import { MessageSubType } from "telegraf/typings/telegram-types";
import { Message } from "telegraf/typings/core/types/typegram";
// --

import {
	code,
	MCChat,
	ChatComponent,
	escapeHTML,
	deunionise,
	isCommand,
	parseCommand,
} from "./utils";

const pkg = require("../package.json") as { name: string; version: string };

const tgOpts = { parse_mode: "HTML" } as const;

const createError = (...str: string[]) =>
	new Error(`[${pkg.name}@${pkg.version}] ` + str.join(" "));

type Opts = {
	/** Enable the plugin */
	enable: boolean;
	/** Telegram Bot Token */
	token: string;
	/** Telegram Chat ID */
	chatId: string;
	/** /list Options */
	list?: {
		/** Allow the use of /list */
		allow?: boolean;
		/** Time to wait for list, in milliseconds */
		timeout?: number;
	};
	/** Telegraf Options */
	// Todo(mkr): Telegraf.Options after 4.0.1
	telegraf?: any;
};

type messenger = Messenger<string | number>;

const Telegram: Plugin<Opts, [], messenger["exports"]> = opts => {
	if (!opts.token) throw createError("'token' was not provided");

	const bot = new Telegraf(opts.token, opts.telegraf);
	const botID = opts.token.split(":")[0];

	const ev = new EventEmitter();

	const on = ev.on.bind(ev);
	const off = ev.off.bind(ev);
	const once = ev.off.bind(ev);
	const emit: messenger["emit"] = ev.emit.bind(ev);

	const telegram = {
		async send(type: "private" | "chat", user: string | number, msg: string) {
			await bot.telegram.sendMessage(user, msg, tgOpts);
		},
		on,
		once,
		off,
		cmdPrefix: "/",
	};

	return {
		name: pkg.name,
		version: pkg.version,
		exports: telegram,
		start: ({ events, store, server, console }) => {
			if (!opts?.enable) return;

			const send = (msg: string) => telegram.send("chat", opts.chatId, msg);

			bot.command("chatid", ctx => ctx.reply(ctx.chat?.id?.toString()!));

			const players = {
				init: false,
				max: 0,
				list: [] as string[],
				add<T extends string>(player: T): T {
					this.list = this.list.filter(x => x !== player).concat([player]);
					return player;
				},
				remove<T extends string>(player: T): T {
					this.list = this.list.filter(x => x !== player);
					return player;
				},
			};

			if (opts.list?.allow) {
				new Promise<[string, string, string[]]>((resolve, reject) => {
					const rejection = setTimeout(
						() => reject(new Error("/list took too long!")),
						opts.list?.timeout || 15 * 1000,
					);

					const cleanup = () => {
						clearTimeout(rejection);
					};

					events.once("core:close", cleanup);

					return events.once("minecraft:playercount", count => {
						clearTimeout(rejection);
						events.off("core:close", cleanup);
						resolve([
							count.current,
							count.max,
							(count.players || "")
								.split(/\s*,\s*/)
								.filter((l: string) => l.length > 0),
						]);
					});
				})
					.then(([, max, ps]) => {
						players.init = true;
						players.max = parseInt(max);
						players.list = ps;

						// Poll for list every 5 seconds to tolerate unexpectedly missed login/logout
						const interval = setInterval(
							() => server.send("list"),
							5 * 60 * 1000,
						);

						events.on("core:close", () => clearInterval(interval));

						events.on("minecraft:playercount", count => {
							players.max = parseInt(count.max);
							players.list = (count.players || "")
								.split(/\s*,\s*/)
								.filter((l: string) => l.length > 0);
						});
					})
					.catch(e => {
						if (e === "CANCEL") return;
						throw new Error(e);
					});

				server.send("list");

				bot.command("list", ctx =>
					players.init
						? ctx.reply(
								[
									`Players online (`,
									`${code(players.list.length)}/${code(players.max)})`,
									players.list.length
										? `:\n${code(players.list.join("\n"))}`
										: "",
								].join(""),
								tgOpts,
						  )
						: ctx.reply("Player list not initialised."),
				);
			}

			events.on("minecraft:message", ctx => {
				send(code(ctx.user) + " " + escapeHTML(ctx.text));
			});

			events.on("minecraft:self", ctx =>
				send(code("* " + ctx.user + " " + ctx.text)),
			);

			events.on("minecraft:say", ctx =>
				send(code(ctx.user + " says: " + ctx.text)),
			);

			events.on("minecraft:join", ctx => {
				send(code(players.add(ctx.user) + " joined the server"));
			});

			events.on("minecraft:leave", ctx =>
				send(code(players.remove(ctx.user) + " left the server")),
			);

			events.on("minecraft:death", ctx =>
				send(code(ctx.user + " " + ctx.text)),
			);

			events.on("minecraft:advancement", ctx =>
				send(
					code(ctx.user) +
						" has made the advancement " +
						code("[" + ctx.advancement + "]"),
				),
			);

			events.on("minecraft:goal", ctx =>
				send(
					code(ctx.user) +
						" has reached the goal " +
						code("[" + ctx.goal + "]"),
				),
			);

			events.on("minecraft:challenge", ctx =>
				send(
					code(ctx.user) +
						" has completed the challenge " +
						code("[" + ctx.challenge + "]"),
				),
			);

			const captionMedia = (
				name: string,
				msg: Message | undefined,
			): ChatComponent[] => {
				const coloured: ChatComponent[] = [
					{ text: "[", color: "white" },
					{ text: name, color: "gray" },
					{ text: "]", color: "white" },
				];

				return msg && "caption" in msg
					? coloured.concat(MCChat.text(msg?.caption || ""))
					: coloured;
			};

			const extractMinecraftUsername = (text: string = "") =>
				text.split(" ").slice(0, 1).join(" ");

			const removeMinecraftUsername = (text: string = "") =>
				text.split(" ").slice(1).join(" ");

			const getTelegramName = (msg?: Message) => {
				const from = msg?.from;
				return [from?.first_name, from?.last_name].filter(Boolean).join(" ");
			};

			const isSelf = (ctx?: { from?: { id: number } }) =>
				String(ctx?.from?.id) === botID;

			const getSender = (ctx: Context) =>
				isSelf(ctx)
					? extractMinecraftUsername(
							ctx.message && "text" in ctx.message ? ctx.message.text : "",
					  )
					: getTelegramName(ctx.message);

			const handledTypes: MessageSubType[] = [
				"voice",
				"video_note",
				"video",
				"animation",
				"venue",
				"text",
				"successful_payment",
				"sticker",
				"photo",
				"location",
				"invoice",
				"game",
				"dice",
				"document",
				"contact",
				"audio",
				"poll",
			];

			const getCaptioned = (msg: Message | undefined) => {
				const thisType = handledTypes.find(type => msg && type in msg);
				if (thisType === "text") return msg && deunionise(msg)?.text;
				if (thisType)
					return captionMedia(
						thisType.split("_").join(" ").toUpperCase(),
						msg,
					);
			};

			const handler: Middleware<Context> = (ctx, next) => {
				const isLinkedGroup = String(ctx.message?.chat.id) === opts.chatId;
				const isBotPM = ctx.message?.chat.type === "private";
				const messageText = getCaptioned(ctx.message) || "";
				const isMessageCommand = typeof messageText == "string" && isCommand(messageText);

				if(isMessageCommand) {
					// commands can be from either PM or linked group
					if(!(isLinkedGroup || isBotPM)) return next();
				} else {
					 // regular texts must be from linked group
					if(!isLinkedGroup || isBotPM) return next();
					// if it's indeed from the linked group but
					// no players are online, don't relay
					else if(players.list.length < 1) return next();
				}

				const reply = ctx.message && deunionise(ctx.message)?.reply_to_message;
				const self = isSelf(ctx);

				const fromDetails = self
					? {
							from: { name: getSender(ctx) },
							source: "minecraft" as const,
					  }
					: {
							from: {
								name: getSender(ctx),
								username: ctx.from?.username!,
								id: ctx.from?.id!,
								source: ctx.chat?.id!,
								type: isBotPM ? ("private" as const) : ("chat" as const),
							},
							source: "self" as const,
					  };

				const replyDetails = reply && {
					replyTo: {
						from:
							String(reply.from?.id) === botID
								? extractMinecraftUsername("text" in reply ? reply.text : "")
								: getTelegramName(reply),
						text:
							(isSelf(reply)
								? removeMinecraftUsername("text" in reply ? reply.text : "")
								: getCaptioned(reply)) || "",
						source: isSelf(reply) ? ("minecraft" as const) : ("self" as const),
					},
				};

				const emitCtx = Object.assign(
					{ text: messageText },
					fromDetails,
					replyDetails,
				);

				if (
					emitCtx.source === "self" &&
					typeof emitCtx.text === "string" &&
					isCommand(emitCtx.text)
				) {
					const cmd = parseCommand(emitCtx.text);
					emit(cmd.cmd, Object.assign(emitCtx, cmd));
				} else {
					const chatMessage = MCChat.message(emitCtx);

					server.send("tellraw @a " + JSON.stringify(chatMessage));
				}
			};

			bot.on(handledTypes, handler);

			events.once("core:close", () => {
				console.log("Stopping bot...");
				bot.stop();
				console.log("Bot stopped.");
			});

			bot.catch(console.error);

			bot.launch(opts.telegraf);
		},
	};
};

export default Telegram;
