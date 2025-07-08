import sys
import json
import requests

def handle_search(query):
    # 使用 GitHub 搜索 API
    try:
        url = f"https://api.github.com/search/repositories?q={query}"
        response = requests.get(url)
        data = response.json()
        items = data.get("items", [])[:5]  # 只返回前 5 项
        results = [{"name": repo["full_name"], "url": repo["html_url"]} for repo in items]
        return {"results": results}
    except Exception as e:
        return {"error": str(e)}

def main():
    # ✅ 第一步：立即向 stdout 输出 initialized 响应
    print(json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "protocolVersion": "2025-03-26"
        }
    }), flush=True)

    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get("method")
            request_id = request.get("id")

            # ✅ 返回初始化确认
            if method == "initialize":
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": "initialized"
                }), flush=True)
                continue

            # ✅ 返回工具描述信息
            if method == "prompts/list" or method == "tools/list":
                response = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "tools": [
                            {
                                "name": "github_search",
                                "description": "Search GitHub for repositories matching a query.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "query": {"type": "string"}
                                    },
                                    "required": ["query"]
                                }
                            }
                        ]
                    }
                }
                print(json.dumps(response), flush=True)
                continue

            # ✅ 实际调用工具
            if method == "tools/call":
                params = request.get("params", {})
                tool_name = params.get("name")
                arguments = params.get("arguments", {})

                if tool_name == "github_search":
                    query = arguments.get("query", "")
                    result = handle_search(query)
                else:
                    result = {"error": f"Unknown tool: {tool_name}"}

                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": result
                }), flush=True)

        except Exception as e:
            print(json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"message": str(e)}
            }), flush=True)

if __name__ == "__main__":
    main()
