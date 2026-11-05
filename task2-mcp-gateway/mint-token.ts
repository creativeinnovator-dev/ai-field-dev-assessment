// usage: node task2-mcp-gateway/mint-token.ts <admin|viewer> [sub]
import { signToken, type Role } from "./auth.ts";

const role = (process.argv[2] ?? "viewer") as Role;
const sub = process.argv[3] ?? `${role}-user`;
const secret = process.env.JWT_SECRET ?? "dev-secret-change-me";
console.log(signToken({ sub, role, exp: Math.floor(Date.now() / 1000) + 3600 }, secret));
