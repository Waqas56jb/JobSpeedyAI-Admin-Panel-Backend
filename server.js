import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcryptjs';

/**
 * Simple single-file Express API for Vercel / Neon
 *
 * Environment variables you must set in Vercel (Project → Settings → Environment Variables):
 *
 * - PGHOST       (from Neon)
 * - PGPORT       (from Neon, usually 5432)
 * - PGDATABASE   (database name)
 * - PGUSER       (database user)
 * - PGPASSWORD   (database password)
 * - PGSSLMODE    (set to "require" for Neon)
 *
 * Alternatively, you can set DATABASE_URL with a full Postgres connection string.
 */

// --- Database pool (Neon Postgres) ---
let poolInstance = null;

function getDbPool() {
  if (poolInstance) return poolInstance;

  const { DATABASE_URL } = process.env;

  if (DATABASE_URL) {
    poolInstance = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
    return poolInstance;
  }

  const {
    PGHOST,
    PGPORT,
    PGDATABASE,
    PGUSER,
    PGPASSWORD,
    PGSSLMODE,
  } = process.env;

  const host = (PGHOST ?? 'localhost').toString();
  const port = Number(PGPORT ?? 5432);
  const database = (PGDATABASE ?? 'jobspeedy').toString();
  const user = (PGUSER ?? 'postgres').toString();
  const password = String(PGPASSWORD ?? '');
  const useSsl = (PGSSLMODE ?? '').toLowerCase() === 'require';

  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(password);
  const connectionString = `postgresql://${encodedUser}:${encodedPass}@${host}:${port}/${database}`;

  poolInstance = new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
  });

  return poolInstance;
}

const pool = getDbPool();

// --- Express app ---
const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// --- Health check endpoints ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'jobspeedy-ai-admin-backend',
    time: new Date().toISOString(),
  });
});

app.get('/api/db-health', async (req, res) => {
  try {
    const result = await pool.query('select 1 as ok');
    res.json({ status: 'ok', result: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// --- AUTH: admin_users table (from schema.sql) ---

// POST /api/auth/register-admin
app.post('/api/auth/register-admin', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const normalized = String(email).trim().toLowerCase();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(normalized)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'insert into admin_users (email, password_hash) values ($1, $2) returning id, email',
      [normalized, hashed]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login-admin
app.post('/api/auth/login-admin', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const lower = String(email).toLowerCase();
    const r = await pool.query(
      'select id, email, password_hash from admin_users where email = $1',
      [lower]
    );
    if (r.rowCount !== 1) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, r.rows[0].password_hash || '');
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json({ user: { id: r.rows[0].id, email: r.rows[0].email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- USERS (candidates) ---

// POST /api/users - create user
app.post('/api/users', async (req, res) => {
  const { full_name, email, password, phone } = req.body || {};
  if (!full_name || !email || !password) {
    return res
      .status(400)
      .json({ error: 'full_name, email and password are required' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `insert into users (full_name, email, password_hash, phone)
       values ($1, $2, $3, $4)
       returning id, full_name, email, phone, created_at`,
      [full_name, email.toLowerCase(), hashed, phone || null]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users - list all users
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      'select id, full_name, email, phone, created_at from users order by created_at desc'
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id
app.get('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'select id, full_name, email, phone, created_at from users where id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'delete from users where id = $1 returning id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- JOBS (matches schema.sql: title, department, description, requirements[], status, created_by) ---

// GET /api/jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const result = await pool.query(
      'select * from jobs order by created_at desc'
    );
    res.json({ jobs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs
app.post('/api/jobs', async (req, res) => {
  const {
    title,
    department,
    description,
    requirements,
    status = 'Open',
    created_by = 'Admin',
  } = req.body || {};

  if (!title || !department) {
    return res
      .status(400)
      .json({ error: 'title and department are required' });
  }

  let reqArray = requirements;
  if (typeof requirements === 'string') {
    reqArray = requirements
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(reqArray)) {
    reqArray = [];
  }

  try {
    const result = await pool.query(
      `insert into jobs (title, department, description, requirements, status, created_by)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [title, department, description || null, reqArray, status, created_by]
    );
    res.status(201).json({ job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id
app.get('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('select * from jobs where id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/jobs/:id
app.put('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  const {
    title,
    department,
    description,
    requirements,
    status,
    created_by,
  } = req.body || {};

  let reqArray = requirements;
  if (typeof requirements === 'string') {
    reqArray = requirements
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  try {
    const result = await pool.query(
      `update jobs
         set title = coalesce($1, title),
             department = coalesce($2, department),
             description = coalesce($3, description),
             requirements = coalesce($4, requirements),
             status = coalesce($5, status),
             created_by = coalesce($6, created_by),
             updated_at = now()
       where id = $7
       returning *`,
      [title, department, description, reqArray, status, created_by, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/jobs/:id
app.delete('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'delete from jobs where id = $1 returning id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ message: 'Job deleted', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- APPLICATIONS ---

// GET /api/applications
app.get('/api/applications', async (req, res) => {
  try {
    const result = await pool.query(
      `select a.*, u.full_name, u.email, j.title as job_title
       from applications a
       join users u on u.id = a.user_id
       join jobs j on j.id = a.job_id
       order by a.created_at desc`
    );
    res.json({ applications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/applications
app.post('/api/applications', async (req, res) => {
  const {
    user_id,
    job_id,
    resume_url,
    cover_letter,
    status = 'Pending',
    ai_parsed_data,
    admin_notes,
  } = req.body || {};

  if (!user_id || !job_id) {
    return res
      .status(400)
      .json({ error: 'user_id and job_id are required' });
  }

  try {
    const result = await pool.query(
      `insert into applications
         (user_id, job_id, resume_url, cover_letter, status, ai_parsed_data, admin_notes)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [
        user_id,
        job_id,
        resume_url || null,
        cover_letter || null,
        status,
        ai_parsed_data || null,
        admin_notes || null,
      ]
    );
    res.status(201).json({ application: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res
        .status(409)
        .json({ error: 'User has already applied to this job' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id/applications - all applications for a job
app.get('/api/jobs/:id/applications', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `select a.*, u.full_name, u.email
       from applications a
       join users u on u.id = a.user_id
       where a.job_id = $1
       order by a.created_at desc`,
      [id]
    );
    res.json({ applications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id/applications - all applications for a user
app.get('/api/users/:id/applications', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `select a.*, j.title as job_title
       from applications a
       join jobs j on j.id = a.job_id
       where a.user_id = $1
       order by a.created_at desc`,
      [id]
    );
    res.json({ applications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CLIENTS ---

// GET /api/clients
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query(
      'select * from clients order by created_at desc'
    );
    res.json({ clients: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients
app.post('/api/clients', async (req, res) => {
  const { company, contact_person, email } = req.body || {};
  if (!company) {
    return res.status(400).json({ error: 'company is required' });
  }
  try {
    const result = await pool.query(
      `insert into clients (company, contact_person, email)
       values ($1, $2, $3)
       returning *`,
      [company, contact_person || null, email || null]
    );
    res.status(201).json({ client: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'company already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- Start server (for local dev and for Vercel Node server) ---
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);
});

export default app;


