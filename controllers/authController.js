const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = new PrismaClient();

// ----------------------------------------------------
// 🧾 REGISTER - Regular User Signup
// ----------------------------------------------------
const register = async (req, res) => {
  const { fullName, rcmId, email, phone, password, role } = req.body;

  if (!fullName || !rcmId || !email || !phone || !password) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        fullName,
        rcmId,
        email,
        phone,
        password: hashedPassword,
        role: role === 'ADMIN' ? 'ADMIN' : 'USER',
      },
    });
    res.status(201).json({ message: 'User created successfully', userId: user.id });
  } catch (error) {
    if (error.code === 'P2002') {
      return res
        .status(400)
        .json({ message: `The ${error.meta.target.join(', ')} is already taken (RCM ID or Email).` });
    }
    console.error('User registration error:', error);
    res.status(500).json({ message: 'Error creating user', error: error.message });
  }
};

// ----------------------------------------------------
// 🔐 LOGIN - User or Admin
// ----------------------------------------------------
const login = async (req, res) => {
  const { loginId, password } = req.body;

  if (!loginId || !password) {
    return res.status(400).json({ message: 'Login ID (RCM ID or Email) and password are required' });
  }

  try {
    let user;

    if (loginId.includes('@')) {
      user = await prisma.user.findUnique({ where: { email: loginId } });
    } else {
      user = await prisma.user.findUnique({ where: { rcmId: loginId } });
    }

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid Login ID or Password' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
      },
    });
  } catch (error) {
    console.error('Login attempt failed:', error);
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
};

// ----------------------------------------------------
// 👑 ADMIN SIGNUP - No Admin Key Needed
// ----------------------------------------------------
const adminSignup = async (req, res) => {
  const { fullName, email, password } = req.body;

  if (!fullName || !email || !password) {
    return res
      .status(400)
      .json({ message: 'Full Name, Email, and Password are required for Admin setup.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const adminUser = await prisma.user.create({
      data: {
        fullName,
        email,
        password: hashedPassword,
        role: 'ADMIN',
        rcmId: null,
        phone: null,
      },
    });

    res.status(201).json({
      message: '✅ Admin account created successfully. Please login.',
      userId: adminUser.id,
      role: adminUser.role,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res
        .status(400)
        .json({ message: `The ${error.meta.target.join(', ')} is already taken (Email).` });
    }
    console.error('Admin signup error:', error);
    res.status(500).json({ message: 'Error creating Admin user', error: error.message });
  }
};

module.exports = { register, login, adminSignup };
