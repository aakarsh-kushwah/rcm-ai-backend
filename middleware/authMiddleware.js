// backend/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const { db } = require('../config/db');

// Middleware to protect routes
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // ✅ Fetch user from Sequelize instead of Prisma
      const user = await db.User.findByPk(decoded.id, {
        attributes: ['id', 'role', 'email', 'fullName'],
      });

      if (!user) {
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      req.user = user; // attach user info to request
      next();
    } catch (error) {
      console.error('❌ Token verification error:', error);
      return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
    }
  } else {
    return res.status(401).json({ message: 'Not authorized, token missing' });
  }
};

// Middleware to restrict access to admins only
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'ADMIN') {
    next();
  } else {
    res.status(403).json({ message: 'Access denied — Admins only' });
  }
};

module.exports = { protect, isAdmin };
