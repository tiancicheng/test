#!/usr/bin/env node

/**
 * MCP Bridge - RESTful Proxy for Model Context Protocol Servers
 * A lightweight, LLM-agnostic proxy that connects to multiple MCP servers
 * and exposes their capabilities through a unified REST API.
 */

// Import dependencies
const express = require('express');
const cors = require('cors'); //启用 CORS（跨源资源共享），允许前端从不同域访问该服务。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid'); //引入 UUID 生成器（版本 4），用于为请求或任务生成唯一标识符。

// Risk level constants
const RISK_LEVEL = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3
};

// Risk level descriptions
const RISK_LEVEL_DESCRIPTION = {
  [RISK_LEVEL.LOW]: "Low risk - Standard execution",
  [RISK_LEVEL.MEDIUM]: "Medium risk - Requires confirmation",
  [RISK_LEVEL.HIGH]: "High risk - Docker execution required"
};

console.log('Starting MCP Bridge...');

// Create Express application  Express 应用实例初始化
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

console.log('Middleware configured');

// Server state 服务状态追踪结构（用于进程管理等）
const serverProcesses = new Map(); // Map of server IDs to processes
const pendingConfirmations = new Map(); // Map of request IDs to pending confirmations
const serverInitializationState = new Map(); // Track initialization state of servers

// Helper function to load server configuration from file or environment
function loadServerConfig() {
  console.log('Loading server configuration...');
  let config = {};
  
  // Try to load from config file
  const configPath = process.env.MCP_CONFIG_PATH || path.join(process.cwd(), 'mcp_config.json');
  console.log(`Checking for config file at: ${configPath}`);
  
  try {
    if (fs.existsSync(configPath)) {
      const configFile = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configFile).mcpServers || {};
      console.log(`Loaded configuration from ${configPath}:`, Object.keys(config));
      
      // For backward compatibility, validate risk levels if present
      //风险等级校验和降级处理，检查是否定义了 riskLevel，如果非法或高风险但没有 docker 配置，会自动降级为中风险并发出警告。
      for (const [serverId, serverConfig] of Object.entries(config)) {
        if (serverConfig.riskLevel !== undefined) {
          if (![RISK_LEVEL.LOW, RISK_LEVEL.MEDIUM, RISK_LEVEL.HIGH].includes(serverConfig.riskLevel)) {
            console.warn(`Warning: Invalid risk level ${serverConfig.riskLevel} for server ${serverId}, ignoring risk level`);
            delete serverConfig.riskLevel;
          } else if (serverConfig.riskLevel === RISK_LEVEL.HIGH && (!serverConfig.docker || !serverConfig.docker.image)) {
            console.warn(`Warning: Server ${serverId} has HIGH risk level but no docker configuration, downgrading to MEDIUM risk level`);
            serverConfig.riskLevel = RISK_LEVEL.MEDIUM;
          }
        }
      }
    } else {
      console.log(`No configuration file found at ${configPath}, using defaults or environment variables`);
    }
  } catch (error) {
    console.error(`Error loading configuration file: ${error.message}`);
  }
  
  // Allow environment variables to override config 从环境变量覆盖或添加配置
  // Format: MCP_SERVER_NAME_COMMAND, MCP_SERVER_NAME_ARGS (comma-separated) 支持通过环境变量定义新的 server，自动识别
  // process 是 Node.js 提供的全局对象，不需要引入即可使用，代表当前的运行进程。
  // 环境变量覆盖，动态添加/覆盖一个 server 的运行配置，包括命令、参数、环境变量、风险等级、是否要 Docker 隔离。
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('MCP_SERVER_') && key.endsWith('_COMMAND')) {
      const serverName = key.replace('MCP_SERVER_', '').replace('_COMMAND', '').toLowerCase();
      const command = process.env[key];

      const argsKey = `MCP_SERVER_${serverName.toUpperCase()}_ARGS`;
      const args = process.env[argsKey] ? process.env[argsKey].split(',') : [];
      
      // Create or update server config
      config[serverName] = {
        command,
        args
      };
      
      // Check for environment variables
      const envKey = `MCP_SERVER_${serverName.toUpperCase()}_ENV`;
      if (process.env[envKey]) {
        try {
          config[serverName].env = JSON.parse(process.env[envKey]);
        } catch (error) {
          console.error(`Error parsing environment variables for ${serverName}: ${error.message}`);
        }
      }
      
      // Check for risk level 自动分类入口，同时在 POST /servers 中也支持通过请求体传入 riskLevel 来动态指定。
      const riskLevelKey = `MCP_SERVER_${serverName.toUpperCase()}_RISK_LEVEL`;
      if (process.env[riskLevelKey]) {
        try {
          const riskLevel = parseInt(process.env[riskLevelKey], 10);
          if ([RISK_LEVEL.LOW, RISK_LEVEL.MEDIUM, RISK_LEVEL.HIGH].includes(riskLevel)) {
            config[serverName].riskLevel = riskLevel;
            
            // For high risk level, check for docker configuration
            if (riskLevel === RISK_LEVEL.HIGH) {
              const dockerConfigKey = `MCP_SERVER_${serverName.toUpperCase()}_DOCKER_CONFIG`;
              if (process.env[dockerConfigKey]) {
                try {
                  config[serverName].docker = JSON.parse(process.env[dockerConfigKey]);
                } catch (error) {
                  console.error(`Error parsing docker configuration for ${serverName}: ${error.message}`);
                  console.warn(`Server ${serverName} has HIGH risk level but invalid docker configuration, downgrading to MEDIUM risk level`);
                  config[serverName].riskLevel = RISK_LEVEL.MEDIUM;
                }
              } else {
                console.warn(`Server ${serverName} has HIGH risk level but no docker configuration, downgrading to MEDIUM risk level`);
                config[serverName].riskLevel = RISK_LEVEL.MEDIUM;
              }
            }
          } else {
            console.warn(`Invalid risk level ${riskLevel} for server ${serverName}, ignoring risk level`);
          }
        } catch (error) {
          console.error(`Error parsing risk level for ${serverName}: ${error.message}`);
        }
      }
      
      console.log(`Added server from environment: ${serverName}`);
    }
  });
  
  console.log(`Loaded ${Object.keys(config).length} server configurations`);
  return config;
}

// Initialize and connect to MCP servers
async function initServers() {
  console.log('Initializing MCP servers...');
  const serverConfig = loadServerConfig();
  
  console.log('Server configurations found:');
  console.log(JSON.stringify(serverConfig, null, 2));
  
  // Start each configured server
  for (const [serverId, config] of Object.entries(serverConfig)) {
    try {
      console.log(`Starting server: ${serverId}`);
      await startServer(serverId, config);
      console.log(`Server ${serverId} initialized successfully`);
    } catch (error) {
      console.error(`Failed to initialize server ${serverId}: ${error.message}`);
    }
  }
  
  console.log('All servers initialized');
}

// Start a specific MCP server
async function startServer(serverId, config) {
  console.log(`Starting MCP server process: ${serverId} with command: ${config.command} ${config.args.join(' ')}`);
  
  // Set default risk level to undefined for backward compatibility
  const riskLevel = config.riskLevel;
  
  if (riskLevel !== undefined) {
    console.log(`Server ${serverId} has risk level: ${riskLevel} (${RISK_LEVEL_DESCRIPTION[riskLevel]})`);
    
    // For high risk level, verify docker is configured
    if (riskLevel === RISK_LEVEL.HIGH) {
      if (!config.docker || typeof config.docker !== 'object') {
        throw new Error(`Server ${serverId} has HIGH risk level but no docker configuration`);
      }
      
      console.log(`Server ${serverId} will be started in docker container`); //若为高风险（如模型敏感脚本），则使用 Docker 容器隔离运行，命令如下

    }
  } else {
    console.log(`Server ${serverId} has no risk level specified - using standard execution`);
  }
  
  return new Promise((resolve, reject) => {
    try {
      // Get the npm path
      let commandPath = config.command;
      
      // If high risk, use docker
      if (riskLevel !== undefined && riskLevel === RISK_LEVEL.HIGH) {
        commandPath = 'docker';
        const dockerArgs = ['run', '--rm'];
        
        // Add any environment variables
        if (config.env && typeof config.env === 'object') {
          Object.entries(config.env).forEach(([key, value]) => {
            dockerArgs.push('-e', `${key}=${value}`);
          });
        }
        
        // Add volume mounts if specified
        if (config.docker.volumes && Array.isArray(config.docker.volumes)) {
          config.docker.volumes.forEach(volume => {
            dockerArgs.push('-v', volume);
          });
        }
        
        // Add network configuration if specified
        if (config.docker.network) {
          dockerArgs.push('--network', config.docker.network);
        }
        
        // Add the image and command
        dockerArgs.push(config.docker.image);
        
        // If original command was a specific executable, use it as the command in the container
        if (config.command !== 'npm' && config.command !== 'npx') {
          dockerArgs.push(config.command);
        }
        
        // Add the original args
        dockerArgs.push(...config.args);
        
        // Update args to use docker
        config = {
          ...config,
          originalCommand: config.command,
          command: commandPath,
          args: dockerArgs,
          riskLevel // Keep the risk level
        };
        
        console.log(`Transformed command for docker: ${commandPath} ${dockerArgs.join(' ')}`);
      }
      // If the command is npx or npm, try to find their full paths
      else if (config.command === 'npx' || config.command === 'npm') {
        // On Windows, try to use the npm executable from standard locations
        if (process.platform === 'win32') {
          const possiblePaths = [
            // Global npm installation
            path.join(process.env.APPDATA || '', 'npm', `${config.command}.cmd`),
            // Node installation directory
            path.join(process.env.ProgramFiles || '', 'nodejs', `${config.command}.cmd`),
            // Common Node installation location
            path.join('C:\\Program Files\\nodejs', `${config.command}.cmd`),  //已经添加环境变量，，不用修改
          ];
          
          for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
              console.log(`Found ${config.command} at ${possiblePath}`);
              commandPath = possiblePath;
              break;
            }
          }
        } else {
          // On Unix-like systems, try using which to find the command
          // 查找 .cmd 文件路径（Win）或使用 `which`（Linux/macOS）保证在不同平台下命令都能被正确定位并执行。
          try {
            const { execSync } = require('child_process');
            const whichOutput = execSync(`which ${config.command}`).toString().trim();
            if (whichOutput) {
              console.log(`Found ${config.command} at ${whichOutput}`);
              commandPath = whichOutput;
            }
          } catch (error) {
            console.error(`Error finding full path for ${config.command}:`, error.message);
          }
        }
      }
      
      console.log(`Using command path: ${commandPath}`);
      
      // Special handling for Windows command prompt executables (.cmd files)
      const isWindowsCmd = process.platform === 'win32' && commandPath.endsWith('.cmd');
      const actualCommand = isWindowsCmd ? 'cmd' : commandPath;
      const actualArgs = isWindowsCmd ? ['/c', commandPath, ...config.args] : config.args;
      
      console.log(`Spawning process with command: ${actualCommand} and args:`, actualArgs);
      
      // Combine environment variables
      const envVars = { ...process.env };
      
      // Add custom environment variables if provided
      if (config.env && typeof config.env === 'object') {
        console.log(`Adding environment variables for ${serverId}:`, config.env);
        Object.assign(envVars, config.env);
      } else {
        console.log(`No custom environment variables for ${serverId}`);
      }
      
      // Spawn the server process with shell option for better compatibility
      // 使用 spawn() 启动服务脚本或容器命令。
      const serverProcess = spawn(actualCommand, actualArgs, {
        env: envVars,
        stdio: 'pipe',
        shell: !isWindowsCmd // Use shell only if not handling Windows .cmd specially
      });
      
      console.log(`Server process spawned for ${serverId}, PID: ${serverProcess.pid}`);
      
      // Initialize the server state as 'starting'
      serverInitializationState.set(serverId, 'starting');
      
      // Store the server process with its risk level，设置运行状态追踪表追踪 MCP Server 的初始化进度
      serverProcesses.set(serverId, {
        process: serverProcess,
        riskLevel,
        pid: serverProcess.pid,
        config
      });
      
      // Set up initialization handler，保留进程句柄用于后续通信或终止
      let initializationTimeout;
      const initializationHandler = (data) => {
        try {
          const responseText = data.toString();
          const lines = responseText.split('\n').filter(line => line.trim());
          
          for (const line of lines) {
            try {
              const response = JSON.parse(line);
              
              // Check if this is the initialize response
              if (response.id === 1 && response.result && response.result.protocolVersion) {
                console.log(`Server ${serverId} initialization completed successfully`);
                
                // Mark server as initialized
                serverInitializationState.set(serverId, 'initialized');
                
                // Remove the initialization handler
                serverProcess.stdout.removeListener('data', initializationHandler);
                
                // Clear the timeout
                if (initializationTimeout) {
                  clearTimeout(initializationTimeout);
                }
                
                // Send initialized notification to complete the handshake
                const initializedNotification = {
                  jsonrpc: "2.0",
                  method: "notifications/initialized"
                };
                
                serverProcess.stdin.write(JSON.stringify(initializedNotification) + '\n');
                console.log(`Sent initialized notification to ${serverId}`);
                
                // Add regular stdout handler for future messages
                serverProcess.stdout.on('data', regularStdoutHandler);
                
                // Resolve the promise to indicate the server is ready
                resolve(serverProcess);
                return;
              }
            } catch (parseError) {
              // Ignore JSON parsing errors during initialization
              continue;
            }
          }
        } catch (error) {
          console.error(`Error processing initialization response from ${serverId}:`, error);
        }
      };
      
      // Set up regular stdout handler for non-initialization messages
      const regularStdoutHandler = (data) => {
        console.log(`[${serverId}] STDOUT: ${data.toString().trim()}`);
      };
      
      // Set up stderr handler
      serverProcess.stderr.on('data', (data) => {
        console.log(`[${serverId}] STDERR: ${data.toString().trim()}`);
      });
      
      serverProcess.on('error', (error) => {
        console.error(`[${serverId}] Process error: ${error.message}`);
        serverInitializationState.set(serverId, 'error');
        reject(error);
      });
      
      serverProcess.on('close', (code) => {
        console.log(`[${serverId}] Process exited with code ${code}`);
        serverProcesses.delete(serverId);
        serverInitializationState.delete(serverId);
      });
      
      // Add initialization handler first
      serverProcess.stdout.on('data', initializationHandler);
      
      // Set initialization timeout
      initializationTimeout = setTimeout(() => {
        console.error(`Server ${serverId} initialization timed out`);
        serverInitializationState.set(serverId, 'timeout');
        serverProcess.stdout.removeListener('data', initializationHandler);
        reject(new Error(`Server ${serverId} initialization timed out`));
      }, 30000); // 30 second timeout for initialization
      
      // Wait a moment for the process to start, then send initialize request
      // 初始化握手机制（与 MCP Server 通信）启动后等待 1 秒后发送 "initialize" 请求：
      setTimeout(() => {
        const initializeRequest = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            clientInfo: {
              name: "mcp-bridge",
              version: "1.0.0"
            },
            capabilities: {
              // Add capabilities as needed
            }
          }
        };
        
        serverProcess.stdin.write(JSON.stringify(initializeRequest) + '\n');
        console.log(`Sent initialize request to ${serverId}`);
      }, 1000);
      
    } catch (error) {
      console.error(`Error starting server ${serverId}:`, error);
      serverInitializationState.set(serverId, 'error');
      reject(error);
    }
  });
}

// Shutdown an MCP server
async function shutdownServer(serverId) {
  console.log(`Shutting down server: ${serverId}`);
  const serverInfo = serverProcesses.get(serverId);
  
  if (serverInfo) {
    try {
      console.log(`Killing process for ${serverId}`);
      serverInfo.process.kill();
    } catch (error) {
      console.error(`Error killing process for ${serverId}: ${error.message}`);
    }
    
    serverProcesses.delete(serverId);
  }
  
  // Clean up initialization state
  serverInitializationState.delete(serverId);
  
  console.log(`Server ${serverId} shutdown complete`);
}

// MCP request handler 负责向某个已启动的 MCP Server 发送 JSON-RPC 请求，并异步等待其返回结果。
async function sendMCPRequest(serverId, method, params = {}, confirmationId = null) {
  return new Promise((resolve, reject) => {
    const serverInfo = serverProcesses.get(serverId);
    
    if (!serverInfo) {
      return reject(new Error(`Server '${serverId}' not found or not connected`));
    }
    
    // Check initialization state  验证 Server 是否存在和已初始化
    const initState = serverInitializationState.get(serverId);
    if (initState !== 'initialized') {
      const stateMessage = {
        'starting': 'Server is still starting up',
        'timeout': 'Server initialization timed out',
        'error': 'Server initialization failed'
      }[initState] || 'Server is not properly initialized';
      
      return reject(new Error(`${stateMessage}. Current state: ${initState}`));
    }
    
    const { process: serverProcess, riskLevel, config } = serverInfo;
    
    // Only perform risk level checks if explicitly configured (for backward compatibility)
    if (riskLevel !== undefined && riskLevel === RISK_LEVEL.MEDIUM && method === 'tools/call' && !confirmationId) {
      // Generate a confirmation ID for this request
      //中风险请求需人工确认，不直接发送请求，而是生成 confirmation_id，等待用户确认后再触发执行
      const pendingId = uuidv4();
      console.log(`Medium risk level request for ${serverId}/${method} - requires confirmation (ID: ${pendingId})`);
      
      // Store the pending confirmation
      pendingConfirmations.set(pendingId, {
        serverId,
        method,
        params,
        timestamp: Date.now()
      });
      
      // Return a response that requires confirmation
      return resolve({
        requires_confirmation: true,
        confirmation_id: pendingId,
        risk_level: riskLevel,
        risk_description: RISK_LEVEL_DESCRIPTION[riskLevel],
        server_id: serverId,
        method,
        tool_name: params.name,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes
      });
    }
    
    const requestId = uuidv4();

    //将 JSON-RPC 请求写入 MCP 子进程的标准输入流。
    const request = {
      jsonrpc: "2.0",
      id: requestId,
      method,
      params
    };
    
    console.log(`Sending request to ${serverId}: ${method}`, params);
    
    // Set up one-time response handler
    const messageHandler = (data) => {
      try {
        const responseText = data.toString();
        // Handle potential multiline responses by properly joining and parsing
        let parsedResponse = null;
        let jsonError = null;
        
        try {
          // First try to parse the entire response as a single JSON object
          parsedResponse = JSON.parse(responseText);
        } catch (e) {
          // If that fails, try to split by lines and parse each line
        const lines = responseText.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
              const lineResponse = JSON.parse(line);
              if (lineResponse.id === requestId) {
                parsedResponse = lineResponse;
                break;
              }
            } catch (lineError) {
              jsonError = lineError;
              console.error(`Error parsing JSON line from ${serverId}:`, lineError);
            }
          }
        }
            
        if (parsedResponse && parsedResponse.id === requestId) {
              console.log(`Received response from ${serverId} for request ${requestId}`);
              
              // Remove handler after response is received
              serverProcess.stdout.removeListener('data', messageHandler);
              
          if (parsedResponse.error) {
            return reject(new Error(parsedResponse.error.message || 'Unknown error'));
              }
              
              // For high risk level, add information about docker execution (only if risk level is explicitly set)
              if (riskLevel !== undefined && riskLevel === RISK_LEVEL.HIGH) {
            const result = parsedResponse.result || {};
                return resolve({
                  ...result,
                  execution_environment: {
                    risk_level: riskLevel,
                    risk_description: RISK_LEVEL_DESCRIPTION[riskLevel],
                    docker: true,
                    docker_image: config.docker?.image || 'unknown'
                  }
                });
              }
              
          return resolve(parsedResponse.result); //messageHandler 会解析所有输出（即便是多行）并找到目标 id 的响应，若是 JSON 解析失败，也会优雅处理并返回错误

        } else if (jsonError) {
          // If we couldn't parse any JSON and have an error, handle it gracefully
          console.error(`Failed to parse JSON response from ${serverId}`);
          // Clean up
          serverProcess.stdout.removeListener('data', messageHandler);
          
          // Provide a clean error response
          return reject(new Error(`Invalid response format from MCP server: ${jsonError.message}`));
        }
      } catch (error) {
        console.error(`Error processing response from ${serverId}:`, error);
        // Clean up
        serverProcess.stdout.removeListener('data', messageHandler);
        return reject(new Error(`Error processing response: ${error.message}`));
      }
    };
    
    // Add temporary response handler 设置 stdout 的监听器，等待子进程输出响应
    serverProcess.stdout.on('data', messageHandler);
    
    // Set a timeout for the request 如果 10 秒内未收到目标响应，将报错超时，同时会清理监听器，避免内存泄漏
    const timeout = setTimeout(() => {
      serverProcess.stdout.removeListener('data', messageHandler);
      reject(new Error(`Request to ${serverId} timed out after 10 seconds`));
    }, 10000);
    
    // Send the request
    try {
      serverProcess.stdin.write(JSON.stringify(request) + '\n');
    } catch (error) {
      clearTimeout(timeout);
      serverProcess.stdout.removeListener('data', messageHandler);
      reject(new Error(`Failed to send request to ${serverId}: ${error.message}`));
      return;
    }
    
    // Handle error case
    const errorHandler = (error) => {
      clearTimeout(timeout);
      serverProcess.stdout.removeListener('data', messageHandler);
      serverProcess.removeListener('error', errorHandler);
      reject(error);
    };
    
    serverProcess.once('error', errorHandler);
    
    // Clean up error handler when request completes
    const originalResolve = resolve;
    const originalReject = reject;
    
    resolve = (value) => {
      clearTimeout(timeout);
      serverProcess.removeListener('error', errorHandler);
      originalResolve(value);
    };
    
    reject = (error) => {
      clearTimeout(timeout);
      serverProcess.removeListener('error', errorHandler);
      originalReject(error);
    };
  });
}

// API Routes
console.log('Setting up API routes');

// Get server status 定义了 MCP Bridge 的两个 HTTP API 路由，分别用于 查看当前连接的服务器 和 启动新服务器进程，它们是 MCP 服务管理的核心接口之一。
app.get('/servers', (req, res) => {
  console.log('GET /servers'); //GET	列出所有已连接的 MCP 子服务及状态信息
  const servers = Array.from(serverProcesses.entries()).map(([id, info]) => {
    // Create base server info
    const serverInfo = {
      id,
      connected: true,
      pid: info.pid,
      initialization_state: serverInitializationState.get(id) || 'unknown'
    };
    
    // Only include risk level information if it was explicitly set
    if (info.riskLevel !== undefined) {
      serverInfo.risk_level = info.riskLevel;
      serverInfo.risk_description = RISK_LEVEL_DESCRIPTION[info.riskLevel];
      
      if (info.riskLevel === RISK_LEVEL.HIGH) {
        serverInfo.running_in_docker = true;
      }
    }
    
    return serverInfo;
  });
  
  console.log(`Returning ${servers.length} servers`);
  res.json({ servers });
});

// Start a new server (manual configuration)
app.post('/servers', async (req, res) => {
  console.log('POST /servers', req.body); //POST	允许客户端（如前端页面、调用方）手动 POST配置并启动一个新的 MCP Server
  try {
    const { id, command, args, env, riskLevel, docker } = req.body;
    
    if (!id || !command) {
      console.log('Missing required fields');
      return res.status(400).json({
        error: "Server ID and command are required"
      });
    }
    
    if (serverProcesses.has(id)) {
      console.log(`Server with ID '${id}' already exists`);
      return res.status(409).json({
        error: `Server with ID '${id}' already exists`
      });
    }
    
    // Validate risk level if provided
    if (riskLevel !== undefined) {
      if (![RISK_LEVEL.LOW, RISK_LEVEL.MEDIUM, RISK_LEVEL.HIGH].includes(riskLevel)) {
        return res.status(400).json({
          error: `Invalid risk level: ${riskLevel}. Valid values are: ${RISK_LEVEL.LOW} (low), ${RISK_LEVEL.MEDIUM} (medium), ${RISK_LEVEL.HIGH} (high)`
        });
      }
      
      // For high risk level, docker config is required
      if (riskLevel === RISK_LEVEL.HIGH && (!docker || !docker.image)) {
        return res.status(400).json({
          error: "Docker configuration with 'image' property is required for high risk level servers"
        });
      }
    }
    
    // Create the configuration object - only include riskLevel if explicitly set
    const config = { 
      command, 
      args: args || [], 
      env: env || {}
    };
    
    // Only add risk level if explicitly provided
    if (riskLevel !== undefined) {
      config.riskLevel = riskLevel;
      
      // Add docker config if provided for high risk levels
      if (riskLevel === RISK_LEVEL.HIGH && docker) {
        config.docker = docker;
      }
    }
    
    console.log(`Starting server '${id}' with config:`, config);
    await startServer(id, config);
    
    const serverInfo = serverProcesses.get(id);
    console.log(`Server '${id}' started successfully`);
    
    // Create response object
    const response = {
      id,
      status: "connected",
      pid: serverInfo.pid
    };
    
    // Only include risk level information if explicitly set
    if (serverInfo.riskLevel !== undefined) {
      response.risk_level = serverInfo.riskLevel;
      response.risk_description = RISK_LEVEL_DESCRIPTION[serverInfo.riskLevel];
      
      if (serverInfo.riskLevel === RISK_LEVEL.HIGH) {
        response.running_in_docker = true;
      }
    }
    
    res.status(201).json(response);
  } catch (error) {
    console.error(`Error starting server: ${error.message}`);
    res.status(500).json({
      error: error.message
    });
  }
});

// Stop a server
app.delete('/servers/:serverId', async (req, res) => {
  const { serverId } = req.params;
  console.log(`DELETE /servers/${serverId}`);
  
  if (!serverProcesses.has(serverId)) {
    console.log(`Server '${serverId}' not found`);
    return res.status(404).json({
      error: `Server '${serverId}' not found`
    });
  }
  
  try {
    console.log(`Shutting down server '${serverId}'`);
    await shutdownServer(serverId); //调用
    console.log(`Server '${serverId}' shutdown complete`);
    res.json({
      status: "disconnected"
    });
  } catch (error) {
    console.error(`Error stopping server ${serverId}: ${error.message}`);
    res.status(500).json({
      error: error.message
    });
  }
});

// Get tools for a server 获取指定 MCP Server 上支持的工具列表
app.get('/servers/:serverId/tools', async (req, res) => {
  const { serverId } = req.params;
  console.log(`GET /servers/${serverId}/tools`);
  
  try {
    if (!serverProcesses.has(serverId)) {
      return res.status(404).json({
        error: `Server '${serverId}' not found or not connected`
      });
    }
    
    const result = await sendMCPRequest(serverId, 'tools/list'); //发出 tools/list 的 MCP 请求，返回工具数组
    res.json(result);
  } catch (error) {
    console.error(`Error listing tools for ${serverId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Execute a tool on a server 调用 MCP Server 上指定工具->发出 tools/call 的 MCP 请求->参数从 req.body 获取->返回该工具执行的结果（支持中高风险逻辑）
app.post('/servers/:serverId/tools/:toolName', async (req, res) => {
  const { serverId, toolName } = req.params;
  const arguments = req.body;
  
  console.log(`POST /servers/${serverId}/tools/${toolName}`, arguments);
  
  try {
    if (!serverProcesses.has(serverId)) {
      return res.status(404).json({
        error: `Server '${serverId}' not found or not connected`
      });
    }
    
    const serverInfo = serverProcesses.get(serverId);
    
    // Get risk level information for the response
    const riskLevel = serverInfo.riskLevel;
    
    const result = await sendMCPRequest(serverId, 'tools/call', {
      name: toolName,
      arguments
    });
    
    // Ensure we have a valid result object to return
    if (result === undefined || result === null) {
      return res.status(500).json({ 
        error: "The MCP server returned an empty response" 
      });
    }
    
    // Handle different response formats
    try {
      // Return the parsed result
    res.json(result);
    } catch (jsonError) {
      console.error(`Error stringifying result for tool ${toolName}:`, jsonError);
      // If JSON serialization fails, return a clean error
      res.status(500).json({ 
        error: "Failed to format the response from the MCP server",
        details: jsonError.message
      });
    }
  } catch (error) {
    console.error(`Error executing tool ${toolName}:`, error);
    res.status(500).json({ 
      error: `Error executing tool ${toolName}: ${error.message}` 
    });
  }
});

// Confirm a medium risk level request 用户确认中等风险的工具调用请求,若 confirm: true，则执行原始请求，否则标记为用户拒绝，自动过期时间为 10 分钟
app.post('/confirmations/:confirmationId', async (req, res) => {
  const { confirmationId } = req.params;
  const { confirm } = req.body;
  
  console.log(`POST /confirmations/${confirmationId}`, req.body);
  
  // Check if the confirmation exists
  if (!pendingConfirmations.has(confirmationId)) {
    return res.status(404).json({
      error: `Confirmation '${confirmationId}' not found or expired`
    });
  }
  
  const pendingRequest = pendingConfirmations.get(confirmationId);
  
  // Check if the confirmation is expired (10 minutes)
  const now = Date.now();
  if (now - pendingRequest.timestamp > 10 * 60 * 1000) {
    pendingConfirmations.delete(confirmationId);
    return res.status(410).json({
      error: `Confirmation '${confirmationId}' has expired`
    });
  }
  
  // If not confirmed, just delete the pending request
  if (!confirm) {
    pendingConfirmations.delete(confirmationId);
    return res.json({
      status: "rejected",
      message: "Request was rejected by the user"
    });
  }
  
  try {
    // Execute the confirmed request
    console.log(`Executing confirmed request for ${pendingRequest.serverId}`);
    const result = await sendMCPRequest(
      pendingRequest.serverId, 
      pendingRequest.method, 
      pendingRequest.params,
      confirmationId // Pass the confirmation ID to bypass confirmation check
    );
    
    // Delete the pending request
    pendingConfirmations.delete(confirmationId);
    
    // Return the result
    res.json(result);
  } catch (error) {
    console.error(`Error executing confirmed request: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get resources for a server
app.get('/servers/:serverId/resources', async (req, res) => {
  const { serverId } = req.params;
  console.log(`GET /servers/${serverId}/resources`);
  
  try {
    if (!serverProcesses.has(serverId)) {
      return res.status(404).json({
        error: `Server '${serverId}' not found or not connected`
      });
    }
    
    const result = await sendMCPRequest(serverId, 'resources/list');
    res.json(result);
  } catch (error) {
    console.error(`Error listing resources for ${serverId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific resource 读取具体MCP Server 可用资源内容，调用 resources/read 并传入资源 URI
app.get('/servers/:serverId/resources/:resourceUri', async (req, res) => {
  const { serverId, resourceUri } = req.params;
  console.log(`GET /servers/${serverId}/resources/${resourceUri}`);
  
  try {
    if (!serverProcesses.has(serverId)) {
      return res.status(404).json({
        error: `Server '${serverId}' not found or not connected`
      });
    }
    
    const decodedUri = decodeURIComponent(resourceUri);
    const result = await sendMCPRequest(serverId, 'resources/read', {
      uri: decodedUri
    });
    
    res.json(result);
  } catch (error) {
    console.error(`Error reading resource ${resourceUri}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Get prompts for a server 获取某个 MCP server 提供的 prompt 列表，调用 prompts/list 方法
app.get('/servers/:serverId/prompts', async (req, res) => {
  const { serverId } = req.params;
  console.log(`GET /servers/${serverId}/prompts`);
  
  try {
    if (!serverProcesses.has(serverId)) {
      return res.status(404).json({
        error: `Server '${serverId}' not found or not connected`
      });
    }
    
    const result = await sendMCPRequest(serverId, 'prompts/list');
    res.json(result);
  } catch (error) {
    console.error(`Error listing prompts for ${serverId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Execute a prompt 执行指定的 prompt（模板式指令），调用 prompts/get 方法并传入参数
app.post('/servers/:serverId/prompts/:promptName', async (req, res) => {
  const { serverId, promptName } = req.params;
  const arguments = req.body;
  
  console.log(`POST /servers/${serverId}/prompts/${promptName}`, arguments);
  
  try {
    if (!serverProcesses.has(serverId)) {
      return res.status(404).json({
        error: `Server '${serverId}' not found or not connected`
      });
    }
    
    const result = await sendMCPRequest(serverId, 'prompts/get', {
      name: promptName,
      arguments
    });
    
    // Ensure we have a valid result object to return
    if (result === undefined || result === null) {
      return res.status(500).json({ 
        error: "The MCP server returned an empty response" 
      });
    }
    
    // Handle different response formats
    try {
      // Return the parsed result
    res.json(result);
    } catch (jsonError) {
      console.error(`Error stringifying result for prompt ${promptName}:`, jsonError);
      // If JSON serialization fails, return a clean error
      res.status(500).json({ 
        error: "Failed to format the response from the MCP server",
        details: jsonError.message
      });
    }
  } catch (error) {
    console.error(`Error executing prompt ${promptName}:`, error);
    res.status(500).json({
      error: `Error executing prompt ${promptName}: ${error.message}`
    });
  }
});

// Health check endpoint 健康检查接口（系统状态查询）包括 MCP bridge 本身的运行时信息和当前连接的 MCP servers 状态，返回 uptime、连接数量、各 server 初始化状态等
app.get('/health', (req, res) => {
  console.log('GET /health');
  
  const servers = Array.from(serverProcesses.entries()).map(([id, info]) => {
    // Create base server info
    const serverInfo = {
      id,
      pid: info.pid,
      initialization_state: serverInitializationState.get(id) || 'unknown'
    };
    
    // Only include risk level information if explicitly set
    if (info.riskLevel !== undefined) {
      serverInfo.risk_level = info.riskLevel;
      serverInfo.risk_description = RISK_LEVEL_DESCRIPTION[info.riskLevel];
      
      if (info.riskLevel === RISK_LEVEL.HIGH) {
        serverInfo.running_in_docker = true;
      }
    }
    
    return serverInfo;
  });
  
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    serverCount: serverProcesses.size,
    servers
  });
});

// Start the server 在指定端口（默认 3000）监听 HTTP 请求，启动时自动执行 initServers() 初始化所有配置好的 MCP servers
app.listen(PORT, async () => {
  console.log(`MCP Bridge server running on port ${PORT}`);
  await initServers();
  console.log('Ready to handle requests');
});

// Handle graceful shutdown 优雅地关闭所有子服务器（MCP servers）
// 捕捉退出信号 SIGTERM（如容器关闭）或 SIGINT（如 Ctrl+C），遍历所有 server ID，调用 shutdownServer 停止它们
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down servers...');
  
  const shutdownPromises = [];
  for (const serverId of serverProcesses.keys()) {
    shutdownPromises.push(shutdownServer(serverId));
  }
  
  await Promise.all(shutdownPromises);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down servers...');
  
  const shutdownPromises = [];
  for (const serverId of serverProcesses.keys()) {
    shutdownPromises.push(shutdownServer(serverId));
  }
  
  await Promise.all(shutdownPromises);
  process.exit(0);
});