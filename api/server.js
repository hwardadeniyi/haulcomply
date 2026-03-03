const fastify = require("fastify")({ logger: true });

fastify.get("/health", async () => {
  return { status: "ok", service: "haulcomply-api" };
});

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 8080, host: "0.0.0.0" });
    console.log("Server running");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
