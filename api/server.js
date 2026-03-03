require("dotenv").config();
const fastify = require("fastify")({ logger: true });
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const multipart = require("@fastify/multipart");
const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const { z } = require("zod");

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const prisma = new PrismaClient();

fastify.register(cors, { origin: true });
fastify.register(jwt, { secret: process.env.JWT_SECRET });
fastify.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB

const s3 = new S3Client({
  region: "us-east-1", // DO Spaces uses this placeholder region in SDK
  endpoint: `https://${process.env.SPACES_REGION}.digitaloceanspaces.com`,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET,
  },
});

function hashPassword(pw) {
  // MVP only. Replace with bcrypt in production.
  return `pw_${Buffer.from(pw).toString("base64")}`;
}
function verifyPassword(pw, hashed) {
  return hashPassword(pw) === hashed;
}

async function authGuard(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

fastify.get("/health", async () => ({ ok: true, service: "haulcomply-api" }));

// --- Auth ---
fastify.post("/auth/register", async (req, reply) => {
  const schema = z.object({
    company: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
  });
  const body = schema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) return reply.code(409).send({ error: "Email already exists" });

  const account = await prisma.account.create({ data: { name: body.company } });
  const user = await prisma.user.create({
    data: {
      accountId: account.id,
      email: body.email,
      password: hashPassword(body.password),
      role: "owner",
    },
  });

  const token = fastify.jwt.sign({ userId: user.id, accountId: account.id });
  return { token };
});

fastify.post("/auth/login", async (req, reply) => {
  const schema = z.object({ email: z.string().email(), password: z.string() });
  const body = schema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !verifyPassword(body.password, user.password)) {
    return reply.code(401).send({ error: "Invalid credentials" });
  }
  const token = fastify.jwt.sign({ userId: user.id, accountId: user.accountId });
  return { token };
});

fastify.get("/me", { preHandler: authGuard }, async (req) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  const account = await prisma.account.findUnique({ where: { id: req.user.accountId } });
  return { user: { id: user.id, email: user.email, role: user.role }, account };
});

// --- Drivers ---
fastify.post("/drivers", { preHandler: authGuard }, async (req) => {
  const body = z.object({ name: z.string().min(2), phone: z.string().optional() }).parse(req.body);
  return prisma.driver.create({ data: { ...body, accountId: req.user.accountId } });
});
fastify.get("/drivers", { preHandler: authGuard }, async (req) => {
  return prisma.driver.findMany({ where: { accountId: req.user.accountId }, orderBy: { createdAt: "desc" } });
});

// --- Vehicles ---
fastify.post("/vehicles", { preHandler: authGuard }, async (req) => {
  const body = z.object({
    unitNo: z.string().min(1),
    vin: z.string().optional(),
    plate: z.string().optional(),
  }).parse(req.body);
  return prisma.vehicle.create({ data: { ...body, accountId: req.user.accountId } });
});
fastify.get("/vehicles", { preHandler: authGuard }, async (req) => {
  return prisma.vehicle.findMany({ where: { accountId: req.user.accountId }, orderBy: { createdAt: "desc" } });
});

// --- Deadlines ---
fastify.post("/deadlines", { preHandler: authGuard }, async (req) => {
  const body = z.object({
    title: z.string().min(2),
    category: z.string().min(1),
    dueDate: z.string(),
  }).parse(req.body);

  return prisma.deadline.create({
    data: {
      accountId: req.user.accountId,
      title: body.title,
      category: body.category,
      dueDate: new Date(body.dueDate),
    },
  });
});
fastify.get("/deadlines", { preHandler: authGuard }, async (req) => {
  return prisma.deadline.findMany({ where: { accountId: req.user.accountId }, orderBy: { dueDate: "asc" } });
});

// --- Documents Upload ---
fastify.post("/documents/upload", { preHandler: authGuard }, async (req, reply) => {
  const parts = req.parts();
  let meta = {};
  let filePart = null;

  for await (const part of parts) {
    if (part.type === "file") filePart = part;
    else meta[part.fieldname] = part.value;
  }
  if (!filePart) return reply.code(400).send({ error: "File required" });

  const docType = (meta.docType || "").toString();
  const driverId = meta.driverId ? meta.driverId.toString() : null;
  const vehicleId = meta.vehicleId ? meta.vehicleId.toString() : null;

  const key = `${req.user.accountId}/${Date.now()}_${filePart.filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.SPACES_BUCKET,
    Key: key,
    Body: filePart.file,
    ContentType: filePart.mimetype,
    ACL: "private",
  }));

  const doc = await prisma.document.create({
    data: {
      accountId: req.user.accountId,
      driverId,
      vehicleId,
      docType,
      fileKey: key,
      fileName: filePart.filename,
      mimeType: filePart.mimetype,
      issuedAt: meta.issuedAt ? new Date(meta.issuedAt.toString()) : null,
      expiresAt: meta.expiresAt ? new Date(meta.expiresAt.toString()) : null,
    },
  });

  return { ok: true, document: doc };
});

fastify.get("/documents", { preHandler: authGuard }, async (req) => {
  return prisma.document.findMany({ where: { accountId: req.user.accountId }, orderBy: { createdAt: "desc" } });
});

fastify.get("/documents/:id/signed-url", { preHandler: authGuard }, async (req, reply) => {
  const doc = await prisma.document.findFirst({
    where: { id: req.params.id, accountId: req.user.accountId }
  });
  if (!doc) return reply.code(404).send({ error: "Not found" });

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: process.env.SPACES_BUCKET, Key: doc.fileKey }),
    { expiresIn: 60 * 10 }
  );
  return { url };
});

// --- Reminder cron (MVP: logs only; add email/sms later) ---
cron.schedule("0 * * * *", async () => {
  // hourly
  try {
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 86400000);
    const dueSoon = await prisma.deadline.findMany({
      where: { status: "open", dueDate: { lte: in7, gte: now } },
      take: 50,
    });

    if (dueSoon.length) {
      fastify.log.info({ count: dueSoon.length }, "Deadlines due soon");
      // TODO: send email/SMS and log ReminderEvent
    }
  } catch (e) {
    fastify.log.error(e, "Reminder cron failed");
  }
});

const port = process.env.PORT || 8080;
fastify.listen({ port: Number(port), host: "0.0.0.0" });
