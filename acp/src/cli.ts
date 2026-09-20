#!/usr/bin/env node
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { connectViktorAgent } from "./agent.js";

// stdout carries the protocol; everything else goes to stderr.
if (!process.env.VIKTOR_API_KEY) {
  process.stderr.write("viktor-acp: VIKTOR_API_KEY is not set. The handshake will work, prompts will fail until it is.\n");
}
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
connectViktorAgent(stream);
