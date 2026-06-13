import path from "node:path";
import {
  parse as parseJson,
  printParseErrorCode,
  type ParseError
} from "jsonc-parser";
import { parseDocument } from "yaml";

export class ConfigFileValidationError extends Error {
  statusCode = 400;
  type = "file_validation";

  constructor(
    public fileType: "JSON" | "YAML",
    message: string
  ) {
    super(message);
  }
}

function getPositionText(content: string, offset: number): string | null {
  if (!Number.isFinite(offset)) {
    return null;
  }

  const beforeError = content.slice(0, Math.max(0, offset));
  const lines = beforeError.split("\n");
  return `第 ${lines.length} 行第 ${lines[lines.length - 1].length + 1} 列`;
}

function validateJson(filePath: string, content: string): void {
  const errors: ParseError[] = [];
  parseJson(content, errors, {
    allowTrailingComma: false,
    disallowComments: true
  });
  const firstError = errors[0];
  if (firstError) {
    const position = getPositionText(content, firstError.offset);
    throw new ConfigFileValidationError(
      "JSON",
      `${filePath} JSON 格式错误${position ? `：${position}` : ""}，${printParseErrorCode(firstError.error)}`
    );
  }
}

function validateYaml(filePath: string, content: string): void {
  const document = parseDocument(content, {
    prettyErrors: false,
    strict: true
  });
  const firstError = document.errors[0];
  if (!firstError) {
    return;
  }

  const position =
    firstError.linePos?.[0]
      ? `第 ${firstError.linePos[0].line} 行第 ${firstError.linePos[0].col} 列`
      : getPositionText(content, firstError.pos[0]);
  throw new ConfigFileValidationError(
    "YAML",
    `${filePath} YAML 格式错误${position ? `：${position}` : ""}，${firstError.message}`
  );
}

export function validateConfigFileContent(filePath: string, content: string): void {
  const extension = path.extname(filePath).toLocaleLowerCase();
  if (extension === ".json") {
    validateJson(filePath, content);
    return;
  }

  if (extension === ".yaml" || extension === ".yml") {
    validateYaml(filePath, content);
  }
}
