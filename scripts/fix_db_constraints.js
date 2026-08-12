const { sequelize } = require('../config/db');
const { User } = require('../models');

async function runFix() {
  try {
    console.log('--- STEP 1: Describe users table ---');
    const [results] = await sequelize.query('DESCRIBE users;');
    console.log(results.map(r => ({ Field: r.Field, Type: r.Type, Null: r.Null, Key: r.Key })));

    console.log('\n--- STEP 2: Modify columns to allow NULL ---');
    await sequelize.query('ALTER TABLE users MODIFY COLUMN password VARCHAR(200) NULL;');
    await sequelize.query('ALTER TABLE users MODIFY COLUMN rcm_id VARCHAR(200) NULL;');
    console.log('Successfully modified password and rcm_id to allow NULL.');

    console.log('\n--- STEP 3: Verify updated schema ---');
    const [updatedResults] = await sequelize.query('DESCRIBE users;');
    console.log(updatedResults.filter(r => r.Field === 'password' || r.Field === 'rcm_id').map(r => ({ Field: r.Field, Type: r.Type, Null: r.Null })));

    console.log('\n--- STEP 4: Test creating user with password: null, rcmId: null ---');
    const testEmail = `test_${Date.now()}@google.com`;
    const testUser = await User.create({
      fullName: 'Test Nullability User',
      email: testEmail,
      googleId: `google_${Date.now()}`,
      password: null,
      rcmId: null,
      status: 'active',
      isApproved: true
    });
    console.log('✅ Successfully created user with null password and rcmId:', {
      id: testUser.id,
      email: testUser.email,
      password: testUser.password,
      rcmId: testUser.rcmId
    });

    // Cleanup test user
    await testUser.destroy();
    console.log('✅ Cleaned up test user.');

  } catch (error) {
    console.error('❌ Fix DB Constraints Error:', error);
  } finally {
    await sequelize.close();
  }
}

runFix();
