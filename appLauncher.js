// appLauncher.js

const { exec } = require("child_process");
const readline = require("readline");

// 手动回应 MCP 的初始化握手（第一步）
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-03-26"
  }
}));

// 创建 stdin 监听器
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", (line) => {
  try {
    const request = JSON.parse(line);
    const { id, method } = request;

    // Step 1: 初始化
    if (method === "initialize") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: "initialized"
      }));
      return;
    }

    // Step 2: 工具注册，兼容 tools/list 和 prompts/list
    if (method === 'prompts/list' || method === 'tools/list') {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "list_apps",
              description: "List all installed applications on the system",
              parameters: {
                type: "object",
                properties: {}
              }
            },
            {
              name: "launch_app",
              description: "Launch an application by name or path",
              parameters: {
                type: "object",
                properties: {
                  app: { type: "string" }
                },
                required: ["app"]
              }
            }
          ]
        }
      }));
      return;
    }

    // Step 3: 工具调用
    if (method === "tools/call") {
      handleToolCall(request);
      return;
    }

    // 其他未知方法
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { message: `Unknown method: ${method}` }
    }));

  } catch (err) {
    console.error(JSON.stringify({ error: "Invalid JSON or processing error", details: err.message }));
  }
});

function handleToolCall(request) {
  const id = request.id;
  const toolName = request.params?.name;
  const args = request.params?.arguments || {};

  if (toolName === "list_apps") {
    const powershellCmd = `Get-StartApps | Select-Object Name, AppID | ConvertTo-Json`;
    exec(`powershell -Command "${powershellCmd}"`, (err, stdout) => {
      if (err) {
        console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { message: err.message } }));
        return;
      }
      try {
        const apps = JSON.parse(stdout);
        console.log(JSON.stringify({ jsonrpc: "2.0", id, result: apps }));
      } catch {
        console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { message: "Failed to parse app list" } }));
      }
    });
  }

  else if (toolName === "launch_app") {
    // const appName = args.app;
    const appName = args.app || args.name;
    if (!appName) {
      console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { message: "Missing app name" } }));
      return;
    }

    const escapedApp = appName.replace(/"/g, '\\"');
    const launchCmd = `Start-Process -FilePath "${escapedApp}"`;

    exec(`powershell -Command "${launchCmd}"`, (err) => {
      if (err) {
        console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { message: `Failed to launch: ${err.message}` } }));
        return;
      }
      console.log(JSON.stringify({ jsonrpc: "2.0", id, result: `${appName} launched successfully` }));
    });
  }

  else {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { message: `Unknown tool name: ${toolName}` } }));
  }
}
