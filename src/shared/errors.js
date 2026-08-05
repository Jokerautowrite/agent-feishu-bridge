class AppError extends Error {
  constructor(message, { code = "APP_ERROR", cause } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = cause;
  }
}

module.exports = {
  AppError,
};
