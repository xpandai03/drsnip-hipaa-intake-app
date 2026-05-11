// Auth schema definitions live in ../index.ts directly — see the INLINED
// comment in that file for why. This file is retained as a thin re-export
// so anyone importing from "@workspace/db/schema/auth" (or the
// "./schema/auth" path internally) keeps working.
export {
  insertLoginAttemptSchema,
  insertSessionSchema,
  insertUserSchema,
  loginAttempts,
  sessions,
  users,
} from "../index.js";
export type {
  InsertLoginAttempt,
  InsertSession,
  InsertUser,
  LoginAttempt,
  Session,
  User,
} from "../index.js";
