import sys
import json
import openpyxl

def sum_column(file_path, sheet_name, column_letter):
    wb = openpyxl.load_workbook(file_path, data_only=True)
    sheet = wb[sheet_name]
    total = 0.0
    for cell in sheet[column_letter]:
        try:
            total += float(cell.value)
        except (TypeError, ValueError):
            continue
    return {"sum": total}

def main():
    # ✅ 第一步：向 stdout 输出 initialized 响应，确保 MCP 桥接初始化成功
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

            # ✅ initialize 响应
            if method == "initialize":
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": "initialized"
                }), flush=True)
                continue

            # ✅ 注册工具描述
            if method == "prompts/list" or method == "tools/list":
                response = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "tools": [
                            {
                                "name": "sum_excel_column",
                                "description": "Sum a numeric column in an Excel file.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "file": {"type": "string"},
                                        "sheet": {"type": "string"},
                                        "column": {"type": "string"}
                                    },
                                    "required": ["file", "sheet", "column"]
                                }
                            }
                        ]
                    }
                }
                print(json.dumps(response), flush=True)
                continue

            # ✅ 工具调用处理
            if method == "tools/call":
                params = request.get("params", {})
                tool_name = params.get("name")
                arguments = params.get("arguments", {})

                if tool_name == "sum_excel_column":
                    file = arguments.get("file")
                    sheet = arguments.get("sheet")
                    column = arguments.get("column")
                    result = sum_column(file, sheet, column)
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
