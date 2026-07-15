export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[] | ValidationIssue, message = "配置校验失败") {
    const normalizedIssues = Array.isArray(issues) ? issues : [issues];
    const details = normalizedIssues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("；");

    super(details ? `${message}：${details}` : message);
    this.name = "ValidationError";
    this.issues = normalizedIssues;
  }
}
