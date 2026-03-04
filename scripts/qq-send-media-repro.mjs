#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function now() {
  return new Date().toISOString();
}

function printJson(prefix, data) {
  console.log(`${now()} ${prefix} ${JSON.stringify(data)}`);
}

async function existsFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const wsUrl = args.ws || process.env.ONEBOT_WS_URL;
  const token = args.token || process.env.ONEBOT_ACCESS_TOKEN || "";
  const group = args.group || "20000001";
  const mp4 = args.mp4;
  const txt = args.txt;

  if (!wsUrl || !mp4 || !txt) {
    console.error("Usage: node scripts/qq-send-media-repro.mjs --ws ws://127.0.0.1:3001 --token xxx --group 20000001 --mp4 /openclaw_media/test.mp4 --txt /openclaw_media/test.txt");
    process.exit(2);
  }

  if (!(await existsFile(mp4))) {
    console.error(`mp4 not found: ${mp4}`);
    process.exit(2);
  }
  if (!(await existsFile(txt))) {
    console.error(`txt not found: ${txt}`);
    process.exit(2);
  }

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const ws = new WebSocket(wsUrl, { headers });

  const pending = new Map();
  let seq = 0;

  ws.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      console.log(`${now()} <- NON_JSON ${raw.toString()}`);
      return;
    }
    printJson("<-", payload);
    if (payload?.echo && pending.has(payload.echo)) {
      const done = pending.get(payload.echo);
      pending.delete(payload.echo);
      done(payload);
    }
  });

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  async function call(action, params, timeoutMs = 25000) {
    const echo = `repro_${Date.now()}_${seq++}`;
    const req = { action, params, echo };
    printJson("->", req);
    ws.send(JSON.stringify(req));

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`timeout action=${action} echo=${echo}`));
      }, timeoutMs);

      pending.set(echo, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
    });
  }

  const groupId = Number.parseInt(group, 10);
  if (!Number.isFinite(groupId)) {
    throw new Error(`invalid --group: ${group}`);
  }

  const mp4Name = path.basename(mp4);
  const txtName = path.basename(txt);

  try {
    await call("send_group_msg", {
      group_id: groupId,
      message: `qq-send-media repro start mp4=${mp4Name} txt=${txtName}`,
    });

    await call("send_group_msg", {
      group_id: groupId,
      message: [{ type: "video", data: { file: mp4 } }],
    });

    await call("send_group_msg", {
      group_id: groupId,
      message: [{ type: "file", data: { file: txt, name: txtName } }],
    });

    await call("upload_group_file", {
      group_id: groupId,
      file: mp4,
      name: mp4Name,
    });

    await call("upload_group_file", {
      group_id: groupId,
      file: txt,
      name: txtName,
    });

    await call("send_group_msg", {
      group_id: groupId,
      message: "qq-send-media repro done",
    });
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error(`${now()} ERROR ${err?.stack || err}`);
  process.exit(1);
});
