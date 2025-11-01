const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../config/db');

// Helper to safely access model after DB init
function getUserModel() {
  if (!db.User) throw new Error('User model not initialized yet.');
  return db.User;
}

// ----------------------------------------------------
// 🧾 REGISTER - Regular User Signup
// ----------------------------------------------------
const register = async (req, res) => {
  const { fullName, rcmId, email, phone, password, role } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({
      message: 'Full name, email, and password are required.',
    });
  }

  try {
    const User = getUserModel();

    // ✅ Check if email already exists
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered.' });
    }

    // ✅ Check if RCM ID already exists (only if provided)
    if (rcmId) {
      const existingRcm = await User.findOne({ where: { rcmId } });
      if (existingRcm) {
        return res.status(400).json({ message: 'RCM ID already registered.' });
      }
    }

    // ✅ Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Create new user
    const newUser = await User.create({
      fullName,
      rcmId: rcmId || null,
      email,
      phone: phone || null,
      password: hashedPassword,
      role: role || 'USER',
      status: 'pending',
    });

    // ✅ Create JWT token
    const token = jwt.sign(
      { id: newUser.id, role: newUser.role || 'USER' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // ✅ Send response with token and user info
    res.status(201).json({
      message: 'User created successfully.',
      userId: newUser.id,
      token,
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        email: newUser.email,
        rcmId: newUser.rcmId,
        role: newUser.role,
        status: newUser.status,
      },
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      message: 'Error creating user.',
      error: error.message,
    });
  }
};



// ----------------------------------------------------
// 🔐 LOGIN - User or Admin
// ----------------------------------------------------
const login = async (req, res) => {
  const { loginId, password } = req.body;

  if (!loginId || !password) {
    return res.status(400).json({
      message: 'Login ID (Email or RCM ID) and password are required.',
    });
  }

  try {
    const User = getUserModel();
    let user;

    if (loginId.includes('@')) {
      user = await User.findOne({ where: { email: loginId } });
    } else {
      user = await User.findOne({ where: { rcmId: loginId } });
    }

    if (!user) {
      return res.status(401).json({ message: 'Invalid login ID or password.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid login ID or password.' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role || 'USER' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        rcmId: user.rcmId,
        status: user.status,
        role: user.role || 'USER',
      },
    });
  } catch (error) {
    console.error('Login failed:', error);
    res.status(500).json({ message: 'Login failed.', error: error.message });
  }
};

// ----------------------------------------------------
// 👑 ADMIN SIGNUP
// ----------------------------------------------------
const adminSignup = async (req, res) => {
  const { fullName, email, password } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({
      message: 'Full name, email, and password are required.',
    });
  }

  try {
    const User = getUserModel();
    const existingAdmin = await User.findOne({ where: { email } });
    if (existingAdmin) {
      return res.status(400).json({ message: 'Admin with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = await User.create({
      fullName,
      email,
      password: hashedPassword,
      role: 'ADMIN',
      status: 'active',
    });

    res.status(201).json({
      message: '✅ Admin created successfully.',
      userId: admin.id,
      role: admin.role,
    });
  } catch (error) {
    console.error('Admin signup error:', error);
    res.status(500).json({ message: 'Error creating admin.', error: error.message });
  }
};

module.exports = { register, login, adminSignup };
