// backend/controllers/authController.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = new PrismaClient();

const register = async (req, res) => {
    // User register: Saari fields mandatory hain
    const { fullName, rcmId, email, phone, password, role } = req.body;
    
    // Validation: Ensures all mandatory fields are present for a regular user
    if (!fullName || !rcmId || !email || !phone || !password) {
        return res.status(400).json({ message: 'All fields are required' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                fullName, rcmId, email, phone, password: hashedPassword,
                // Ensures only explicitly passed 'ADMIN' role is set, otherwise default is 'USER'
                role: role === 'ADMIN' ? 'ADMIN' : 'USER', 
            },
        });
        res.status(201).json({ message: 'User created successfully', userId: user.id });
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(400).json({ message: `The ${error.meta.target.join(', ')} is already taken (RCM ID or Email).` });
        }
        console.error("User registration error:", error);
        res.status(500).json({ message: 'Error creating user', error: error.message });
    }
};

const login = async (req, res) => {
    // FIX: loginId se login karein (jo RCM ID ya Email ho sakta hai)
    const { loginId, password } = req.body; 
    
    if (!loginId || !password) {
        return res.status(400).json({ message: 'Login ID (RCM ID or Email) and password are required' });
    }
    
    try {
        let user;
        
        // FIX: Agar @ hai toh email se search karein (Admin/Email login)
        if (loginId.includes('@')) {
            user = await prisma.user.findUnique({ where: { email: loginId } });
        } 
        // Warna rcmId se search karein (Regular User login)
        else {
            user = await prisma.user.findUnique({ where: { rcmId: loginId } });
        }
        
        // Check if user exists and password is correct
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: 'Invalid Login ID or password' });
        }
        
        // Generate JWT token
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
        
        // Return token and safe user details
        res.json({ 
            token, 
            user: { 
                id: user.id, 
                email: user.email, 
                role: user.role, 
                fullName: user.fullName 
            } 
        });
    } catch (error) {
        console.error("Login attempt failed:", error);
        res.status(500).json({ message: 'Login failed', error: error.message });
    }
};

const adminSignup = async (req, res) => {
    // Admin signup: Sirf 3 fields mandatory hain
    const { fullName, email, password } = req.body; 
    
    // Validation: Only checks for the three required fields
    if (!fullName || !email || !password) {
        return res.status(400).json({ message: 'Full Name, Email, and Password are required for Admin setup.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const adminUser = await prisma.user.create({
            data: {
                fullName,
                email,
                password: hashedPassword,
                role: 'ADMIN',
                // CRITICAL: Set mandatory but unnecessary fields to null
                // NOTE: This requires rcmId and phone fields in Prisma schema to be optional (String?)
                rcmId: null,      
                phone: null,
            },
        });

        res.status(201).json({ 
            message: 'Admin account created successfully. Please login.', 
            userId: adminUser.id,
            role: adminUser.role
        });

    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(400).json({ message: `The ${error.meta.target.join(', ')} is already taken (Email).` });
        }
        console.error("Admin signup error:", error);
        res.status(500).json({ message: 'Error creating Admin user', error: error.message });
    }
};

module.exports = { register, login, adminSignup };