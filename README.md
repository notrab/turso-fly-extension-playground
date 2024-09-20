This throwaway example demonstrates the API needed on the Turso Platform API to support Fly's extensions.

- We don't need to call the API, just the models since we're in the context of the API.
- This is in JS, but the API is in Go. The API will need to be updated to support the same functionality.
- This example doesn't handle creating a new organization/user and associating it with a Fly org ID, but the API will need to support that.

1. Install dependencies

   ```bash
   bun install
   ```

2. Add this to your bash context

   The `hellofly` is the `SHARED_SECRET` in `index.ts`

   ```bash
   generate_signature() {
       echo -n "$1" | openssl dgst -sha256 -hmac "hellofly" -binary | xxd -p -c 256
   }
   ```

3. Start the server

   ```bash
   bun run dev
   ```

4. Provision a new extension

   This step will:

   1. Create a new group in the `primary_region`
   2. Create a database in the group called `[name]-group`
   3. Add locations to the group for each `read_region`
   4. Create a token with read/write access for the database

   **organization_id is ignored below and databases are created in a single account until we do SSO related work for Fly**

   ```bash
   body='{
     "name": "my-db",
     "organization_id": "YOUR_ORG_NAME",
     "primary_region": "lhr",
     "read_regions": ["iad", "syd"]
   }'
   signature=$(generate_signature "$body")

   curl -X POST 'http://localhost:3000/extensions' \
     -H "Content-Type: application/json" \
     -H "X-Signature: $signature" \
     -d "$body"
   ```

   This should return a response that looks something like:

   ```json
   {
     "config": {
       "TURSO_DATABASE_URL": "libsql://my-db-YOUR_ORG_NAME.turso.io",
       "TURSO_AUTH_TOKEN": "..."
     },
     "name": "my-db"
   }
   ```

5. Get the status of an extension

   ```bash
   url_path="/extensions/$id?organization_name=$org_name"
   signature=$(echo -n "$url_path" | openssl dgst -sha256 -hmac "$SHARED_SECRET" -hex | sed 's/^.* //')

   curl -X GET "http://localhost:3000$url_path" \
     -H "Content-Type: application/json" \
     -H "X-Signature: $signature"
   ```

   This should return a response that looks something like:

   ```json
   {
     "id": "e5dcd429-5688-4088-a8e2-ac7220ae59d2",
     "name": "my-db",
     "status": "active",
     "group_name": "group-my-db",
     "regions": ["iad", "syd"],
     "primary_region": "lhr"
   }
   ```

6. Updating an extension (such as changing read regions)

   ```bash
   id="my-db"
   body='{
     "organization_name": "YOUR_ORG_NAME",
     "read_regions": ["iad", "syd", "nrt"]
   }'
   signature=$(generate_signature "$body")

   curl -X PATCH "http://localhost:3000/extensions/$id" \
     -H "Content-Type: application/json" \
     -H "X-Signature: $signature" \
     -d "$body"
   ```

   This should return a response that looks something like:

   ```json
   { "message": "Extension updated successfully" }
   ```
