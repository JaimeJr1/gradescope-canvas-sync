export class SessionExpired extends Error {
  constructor(public readonly site: "gradescope" | "canvas") {
    super(`${site} session expired`);
    this.name = "SessionExpired";
  }
}

export class LayoutChanged extends Error {
  constructor(detail: string) {
    super(`page layout changed: ${detail}`);
    this.name = "LayoutChanged";
  }
}
