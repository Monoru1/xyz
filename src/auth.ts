import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/connexion" },
  providers: [Credentials({
    credentials: { email: {}, password: {} },
    authorize: async (raw) => {
      const parsed = z.object({ email: z.string().email(), password: z.string().min(8) }).safeParse(raw);
      if (!parsed.success) return null;
      const user = await db.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
      if (!user || !(await compare(parsed.data.password, user.passwordHash))) return null;
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    },
  })],
  callbacks: {
    jwt({ token, user }) { if (user) token.role = (user as { role?: string }).role; return token; },
    session({ session, token }) { if (session.user) { session.user.id = token.sub ?? ""; session.user.role = String(token.role ?? "CLIENT"); } return session; },
  },
});
