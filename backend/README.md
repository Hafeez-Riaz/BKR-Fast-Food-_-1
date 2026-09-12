# BKR Fast Food backend

This service provides the `/api` endpoints used by the compiled desktop client.

## Run locally

1. Install Node.js 20 or newer and PostgreSQL.
2. Create a database and set `DATABASE_URL` to its PostgreSQL connection string.
3. Run `npm install` and then `npm start` from this directory.
4. Verify `http://localhost:10000/health`.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New > Blueprint** and select the repository.
3. Render will read `render.yaml`, create the PostgreSQL database, and deploy the web service.
4. Open the service URL plus `/health`; it should return `{ "status": "ok" }`.
5. Set the desktop client's `server.url` to `https://YOUR-SERVICE.onrender.com/api`.

The database schema is created automatically when the service starts.
