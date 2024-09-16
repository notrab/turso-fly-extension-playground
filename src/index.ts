import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { HTTPException } from "hono/http-exception";
import crypto from "crypto";

const SHARED_SECRET = "hellofly";
const TURSO_API_TOKEN = "DONOTCOMMITJAMIE";
const TURSO_API_URL = "https://api.turso.tech";

const app = new Hono();

app.use("*", async (c, next) => {
  const signature = c.req.header("X-Signature");
  const body = await c.req.text();
  const hmac = crypto.createHmac("sha256", SHARED_SECRET);
  hmac.update(body);
  const calculatedSignature = hmac.digest("hex");

  if (signature !== calculatedSignature) {
    throw new HTTPException(401, { message: "Invalid signature" });
  }

  await next();
});

// Some questions.. If a user has a group already, we should use that.
// If not, we should create a new group.
// We'll need to fetch the list of groups first?

// What if someone provisions a new database but with a different primary/replica locations?
// Do we just create new groups for every new provision request from Fly?

// We could name groups based on the primary name so we don't always create new groups
// But if someone updated an extension read replica, it would affect all other extensions
// not ideal.

// async function getOrCreateGroup({
//   organizationId,
//   name,
//   location,
// }: {
//   organizationId: string;
//   name: string;
//   // The 3 letter location code
//   location: string;
// }) {
//   const groupsResponse = await fetch(
//     `${TURSO_API_URL}/v1/organizations/${organizationId}/groups/${name}`,
//     {
//       headers: {
//         Authorization: `Bearer ${TURSO_API_TOKEN}`,
//       },
//     },
//   );

//   if (groupsResponse.ok) {
//     const res = await groupsResponse.json();
//     return res.group;
//   }

//   // If no group exists, create a new one
//   const groupResponse = await fetch(
//     `${TURSO_API_URL}/v1/organizations/${organizationId}/groups`,
//     {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${TURSO_API_TOKEN}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({ name, location }),
//     },
//   );

//   if (!groupResponse.ok) {
//     // We probably need to format these responses better so the Fly API knows what went wrong
//     throw new HTTPException(500, { message: "Failed to create Turso group" });
//   }

//   return await groupResponse.json();
// }

app.post("/extensions", async (c) => {
  const body = await c.req.json();
  const { name, organization_id, primary_region, read_regions } = body;

  // Get or create a group for the organization
  const groupName = `${name}-group`;
  const groupResponse = await fetch(
    `${TURSO_API_URL}/v1/organizations/${organization_id}/groups`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TURSO_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: groupName, location: primary_region }),
    },
  );

  if (!groupResponse.ok) {
    throw new HTTPException(500, { message: "Failed to create Turso group" });
  }

  const group = await groupResponse.json();

  // Create a database
  const dbResponse = await fetch(
    `${TURSO_API_URL}/v1/organizations/${organization_id}/databases`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TURSO_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, location: primary_region }),
    },
  );

  if (!dbResponse.ok) {
    throw new HTTPException(500, {
      message: "Failed to create Turso database",
    });
  }

  const { database } = await dbResponse.json();

  // Add read replicas provided by Fly CLI
  for (const region of read_regions) {
    await fetch(
      `${TURSO_API_URL}/v1/organizations/${organization_id}/groups/${group.name}/locations/${region}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TURSO_API_TOKEN}`,
        },
      },
    );
  }

  const tokenResponse = await fetch(
    `${TURSO_API_URL}/v1/organizations/${organization_id}/databases/${database.Name}/auth/tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TURSO_API_TOKEN}`,
      },
    },
  );

  if (!tokenResponse.ok) {
    throw new HTTPException(500, {
      message: "Failed to create auth token for the database",
    });
  }

  const { jwt: authToken } = await tokenResponse.json();

  // Return the provisioning response
  return c.json({
    id: database.id,
    config: {
      TURSO_DATABASE_URL: `libsql://${database.hostname}`,
      TURSO_AUTH_TOKEN: authToken,
    },
    name: database.Name,
  });
});

app.get("/extensions/:id", async (c) => {
  const id = c.req.param("id"); // group/database name is the extension name
  const body = await c.req.json();
  const { organization_name } = body;

  const response = await fetch(
    `${TURSO_API_URL}/v1/organizations/${organization_name}/databases/${id}`,
    {
      headers: {
        Authorization: `Bearer ${TURSO_API_TOKEN}`,
      },
    },
  );

  if (!response.ok) {
    throw new HTTPException(404, { message: "Database not found" });
  }

  const { database } = await response.json();

  const readRegions = database.regions.filter(
    (region: string) => region !== database.primaryRegion,
  );

  return c.json({
    id: database.DbId,
    name: database.Name,
    status: database.archived ? "archived" : "active",
    group_name: database.group,
    regions: readRegions,
    primary_region: database.primaryRegion,
  });
});

app.patch("/extensions/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { organization_name, read_regions } = body;

  // Get database details to find the group
  // We use names, but Fly use IDs, so just ID as the name to keep it simple?
  const dbResponse = await fetch(`${TURSO_API_URL}/v1/databases/${id}`, {
    headers: {
      Authorization: `Bearer ${TURSO_API_TOKEN}`,
    },
  });

  if (!dbResponse.ok) {
    throw new HTTPException(404, { message: "Database not found" });
  }

  const { database } = await dbResponse.json();

  // We need to fetch group to get the current locations (Fly's read regions)
  const groupResponse = await fetch(
    `${TURSO_API_URL}/v1/organizations/${organization_name}/groups/${database.group}`,
    {
      headers: {
        Authorization: `Bearer ${TURSO_API_TOKEN}`,
      },
    },
  );

  if (!groupResponse.ok) {
    throw new HTTPException(500, { message: "Failed to fetch group details" });
  }

  const group = (await groupResponse.json()).group;

  // Add new read replicas
  for (const region of read_regions) {
    if (!group.locations.includes(region)) {
      await fetch(
        `${TURSO_API_URL}/v1/organizations/${organization_name}/groups/${database.group}/locations/${region}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TURSO_API_TOKEN}`,
          },
        },
      );
    }
  }

  // Remove unnecessary locations
  for (const location of group.locations) {
    if (!read_regions.includes(location) && location !== group.primary) {
      await fetch(
        `${TURSO_API_URL}/v1/organizations/${organization_name}/groups/${database.group}/locations/${location}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${TURSO_API_TOKEN}`,
          },
        },
      );
    }
  }

  return c.json({ message: "Extension updated successfully" });
});

app.get("/", (c) => {
  return c.text("Hello Fly!");
});

export default app;
