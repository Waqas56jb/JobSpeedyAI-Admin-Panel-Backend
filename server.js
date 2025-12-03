import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import OpenAI from 'openai';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import PDFDocument from 'pdfkit';

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

const openaiKey = process.env.OPENAI_API_KEY;
const openaiClient = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
const upload = multer(); // memory storage for PDF uploads

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

// --- AI Job Ad Generation ---
app.post('/api/jobs/generate-ad', async (req, res) => {
  const { description } = req.body || {};
  if (!description) {
    return res.status(400).json({ error: 'description is required' });
  }
  if (!openaiClient) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }
  try {
    const completion = await openaiClient.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `You are a professional HR assistant that creates complete job postings.
Return output strictly as JSON with this shape:
{
  "title": "string",
  "company": "string",
  "department": "string",
  "location": "string",
  "job_type": "string",
  "category": "string",
  "language": "string",
  "status": "string",
  "description": "string",
  "required_skills": ["string"],
  "requirements": ["string"]
}`,
        },
        {
          role: 'user',
          content: `Generate a professional job post based on this input: ${description}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content || '{}';
    let jobData;
    try {
      jobData = JSON.parse(content);
    } catch (_) {
      const match =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/);
      jobData = match ? JSON.parse(match[1]) : {};
    }

    const jobAd = {
      title: jobData.title || 'Generated Role',
      company: jobData.company || 'Your Company',
      department: jobData.department || 'General',
      location: jobData.location || 'Remote',
      job_type: jobData.job_type || 'Full-time',
      category: jobData.category || 'General',
      language: jobData.language || 'English',
      status: jobData.status || 'Open',
      description: jobData.description || '',
      required_skills: Array.isArray(jobData.required_skills)
        ? jobData.required_skills
        : typeof jobData.required_skills === 'string'
          ? jobData.required_skills.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
      requirements: Array.isArray(jobData.requirements)
        ? jobData.requirements
        : typeof jobData.requirements === 'string'
          ? jobData.requirements.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
    };

    res.json({ jobAd });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('generate-ad error:', err);
    res.status(500).json({ error: `Failed to generate job ad: ${err.message}` });
  }
});

// --- Resume Parsing Tool ---
app.post('/api/tools/extract-skills', upload.single('resume'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(415).json({ error: 'Only PDF files are supported' });
  }
  if (!openaiClient) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }
  try {
    const pdfData = await pdfParse(req.file.buffer).catch(() => null);
    const text = pdfData?.text?.slice(0, 100000) || '';
    if (!text) {
      return res.status(400).json({ error: 'Could not read PDF text' });
  }

    const prompt = `You are a resume parser. From the resume text below, extract a JSON object with this schema only:
{
  "contact": { "name": "string", "email": "string", "phone": "string", "location": "string" },
  "summary": "string",
  "skills": ["string"],
  "experience": [
    { "title": "string", "company": "string", "start_date": "string", "end_date": "string", "responsibilities": ["string"] }
  ],
  "education": [
    { "degree": "string", "institution": "string", "year": "string" }
  ],
  "certifications": ["string"],
  "languages": ["string"],
  "links": ["string"]
}
Fill missing values with empty strings or empty arrays. Keep lists concise and deduplicated.
Resume text:
${text.substring(0, 12000)}`;

    const completion = await openaiClient.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You extract structured resume data and return JSON only.' },
        { role: 'user', content: prompt },
      ],
    });

    const content = completion.choices[0]?.message?.content || '{}';
    let parsed = {};
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      const match =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/);
      parsed = match ? JSON.parse(match[1]) : {};
    }

    const sanitizeArray = (value) =>
      Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];

    parsed.skills = sanitizeArray(parsed.skills);
    parsed.certifications = sanitizeArray(parsed.certifications);
    parsed.languages = sanitizeArray(parsed.languages);
    parsed.links = sanitizeArray(parsed.links);
    parsed.experience = Array.isArray(parsed.experience) ? parsed.experience : [];
    parsed.education = Array.isArray(parsed.education) ? parsed.education : [];
    parsed.contact = parsed.contact || { name: '', email: '', phone: '', location: '' };

    res.json({ parsed });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('extract-skills error:', err);
    res.status(500).json({ error: 'Failed to extract skills' });
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

// GET /api/users/:id/anonymized-pdf
app.get('/api/users/:id/anonymized-pdf', async (req, res) => {
  const { id } = req.params;
  try {
    const userResult = await pool.query(
      'select id, full_name, email, created_at from users where id = $1',
      [id],
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const applicationResult = await pool.query(
      `select a.ai_parsed_data, a.status, a.created_at, j.title as job_title
       from applications a
       inner join jobs j on j.id = a.job_id
       where a.user_id = $1
       order by a.created_at desc
       limit 1`,
      [id],
    );

    const candidate = userResult.rows[0];
    const application = applicationResult.rows[0] || {};
    const parsed = application.ai_parsed_data || {};

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="anonymized_profile_${id}.pdf"`,
    );
    doc.pipe(res);

    doc.fontSize(20).text('Anonymized Candidate Profile', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Candidate ID: #CND-${String(id).padStart(3, '0')}`);
    doc.moveDown();
    doc.fontSize(12).text(`Latest Application Status: ${application.status || 'N/A'}`);
    if (application.job_title) doc.text(`Recent Role Applied: ${application.job_title}`);
    doc.moveDown();

    if (parsed.summary) {
      doc.fontSize(14).text('Summary:');
      doc.fontSize(12).text(parsed.summary, { align: 'justify' });
      doc.moveDown();
    }

    if (Array.isArray(parsed.skills) && parsed.skills.length > 0) {
      doc.fontSize(14).text('Skills:');
      doc.fontSize(12).text(parsed.skills.join(', '));
      doc.moveDown();
    }

    if (parsed.experience && Array.isArray(parsed.experience) && parsed.experience.length > 0) {
      doc.fontSize(14).text('Experience:');
      parsed.experience.slice(0, 3).forEach((exp) => {
        doc.fontSize(12).text(`${exp.title || 'Role'} at ${exp.company || 'Company'}`);
        doc.fontSize(10).text(`${exp.start_date || 'N/A'} - ${exp.end_date || 'Present'}`);
        if (Array.isArray(exp.responsibilities) && exp.responsibilities.length > 0) {
          doc.fontSize(10).list(exp.responsibilities.slice(0, 3));
        }
        doc.moveDown();
      });
    }

    doc.fontSize(14).text('Generated At:');
    doc.fontSize(12).text(new Date().toLocaleString());
    doc.end();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('anonymized-pdf error:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
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

// GET /api/jobs/:id/xml-feed/:portal
app.get('/api/jobs/:id/xml-feed/:portal', async (req, res) => {
  const { id, portal } = req.params;
  try {
    const result = await pool.query('select * from jobs where id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const job = result.rows[0];
    const skills = Array.isArray(job.requirements || job.required_skills)
      ? (job.requirements || job.required_skills).join(', ')
      : String(job.requirements || job.required_skills || '');
    const createdAt = new Date(job.created_at).toISOString();

    const xmlTemplates = {
      indeed: `<?xml version="1.0" encoding="UTF-8"?>
<jobs>
  <job>
    <title><![CDATA[${job.title || ''}]]></title>
    <company><![CDATA[${job.department || job.company || ''}]]></company>
    <location><![CDATA[${job.location || ''}]]></location>
    <jobtype><![CDATA[${job.job_type || job.status || 'Full-time'}]]></jobtype>
    <category><![CDATA[${job.category || 'General'}]]></category>
    <description><![CDATA[${job.description || ''}]]></description>
    <required_skills><![CDATA[${skills}]]></required_skills>
    <url><![CDATA[https://jobspeedy-ai.com/jobs/${job.id}]]></url>
    <date><![CDATA[${createdAt}]]></date>
  </job>
</jobs>`,
      glassdoor: `<?xml version="1.0" encoding="UTF-8"?>
<source>
  <publisher>JobSpeedy AI</publisher>
  <publisherurl>https://jobspeedy-ai.com</publisherurl>
  <lastBuildDate>${new Date().toISOString()}</lastBuildDate>
  <job>
    <title><![CDATA[${job.title || ''}]]></title>
    <employer><![CDATA[${job.department || job.company || ''}]]></employer>
    <location><![CDATA[${job.location || ''}]]></location>
    <jobtype><![CDATA[${job.job_type || job.status || 'Full-time'}]]></jobtype>
    <description><![CDATA[${job.description || ''}]]></description>
    <skills><![CDATA[${skills}]]></skills>
    <url><![CDATA[https://jobspeedy-ai.com/jobs/${job.id}]]></url>
    <date><![CDATA[${createdAt}]]></date>
  </job>
</source>`,
      linkedin: `<?xml version="1.0" encoding="UTF-8"?>
<source>
  <publisherName>JobSpeedy AI</publisherName>
  <publisherUrl>https://jobspeedy-ai.com</publisherUrl>
  <lastBuildDate>${new Date().toISOString()}</lastBuildDate>
  <job>
    <jobId>${job.id}</jobId>
    <title><![CDATA[${job.title || ''}]]></title>
    <companyName><![CDATA[${job.department || job.company || ''}]]></companyName>
    <location><![CDATA[${job.location || ''}]]></location>
    <jobType><![CDATA[${job.job_type || job.status || 'FULL_TIME'}]]></jobType>
    <description><![CDATA[${job.description || ''}]]></description>
    <skills><![CDATA[${skills}]]></skills>
    <url><![CDATA[https://jobspeedy-ai.com/jobs/${job.id}]]></url>
    <postedDate>${createdAt}</postedDate>
  </job>
</source>`,
      generic: `<?xml version="1.0" encoding="UTF-8"?>
<jobfeed>
  <job>
    <id>${job.id}</id>
    <title><![CDATA[${job.title || ''}]]></title>
    <company><![CDATA[${job.department || job.company || ''}]]></company>
    <location><![CDATA[${job.location || ''}]]></location>
    <job_type><![CDATA[${job.job_type || job.status || 'Full-time'}]]></job_type>
    <category><![CDATA[${job.category || 'General'}]]></category>
    <description><![CDATA[${job.description || ''}]]></description>
    <required_skills><![CDATA[${skills}]]></required_skills>
    <url>https://jobspeedy-ai.com/jobs/${job.id}</url>
    <created_at>${createdAt}</created_at>
  </job>
</jobfeed>`,
    };

    const key = (portal || 'generic').toLowerCase();
    const xml = xmlTemplates[key];
    if (!xml) {
      return res.status(400).json({ error: 'Unsupported portal' });
    }

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="job_${job.id}_${key}.xml"`);
    res.send(xml);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('xml-feed error:', err);
    res.status(500).json({ error: 'Failed to generate XML feed' });
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
      `select 
         c.id,
         c.company,
         c.contact_person,
         c.email,
         c.created_at,
         (
           select count(1)
           from jobs j
           where j.client_id = c.id
              or (j.department is not null and j.department = c.company)
         ) as jobs_count
       from clients c
       order by c.created_at desc`,
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


