const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { Admin } = require('../models');

async function runImport() {
  try {
    const secret = process.env.JWT_SECRET || process.env.JWT_ADMIN_SECRET || 'secret';
    
    // 1. Dynamically fetch an active SuperAdmin
    const admin = await Admin.findOne({
      where: {
        role: 'superadmin', // Assuming 'superadmin' role identifies an admin
        // You might need to add other conditions for an 'active' admin if available in the Admin model
      }
    });

    if (!admin) {
      console.error('❌ No active SuperAdmin found in the database. Please ensure an admin user exists.');
      return;
    }

    // 2. Generate Bearer Token with real admin data
    const token = jwt.sign(
      { id: admin.id, role: admin.role, roleName: 'Super Admin', email: admin.email },
      secret,
      { expiresIn: '1h' }
    );

    console.log(`✅ Generated SuperAdmin Auth Token for admin: ${admin.email} successfully.`);

    // 3. Target Endpoints to test
    const endpoints = [
      'http://localhost:5000/api/v1/admin/instagram/import'
    ];

    const payload = {
      input: 'https://www.instagram.com/digital_kahaniyan5?stkn=c3FvYzFqM2s3amU=',
      category: 'Motivation'
    };

    let response = null;
    for (const url of endpoints) {
      try {
        console.log(`📡 Trying POST request to: ${url}`);
        response = await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        });
        if (response && response.status < 400) {
          console.log(`🎯 SUCCESS from endpoint: ${url}`);
          break;
        }
      } catch (err) {
        if (err.response && err.response.status === 404) {
          console.log(`⚠️ Route not found at ${url}, trying next...`);
          continue;
        }
        throw err;
      }
    }

    if (!response) {
      throw new Error('All import endpoint variations returned 404.');
    }

    console.log('\n--- API RESPONSE ---');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('--------------------\n');

  } catch (error) {
    console.error('\n❌ Import Script Failed:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error('Data:', error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

runImport();