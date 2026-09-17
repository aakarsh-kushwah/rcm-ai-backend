const axios = require('axios');

const BASE_URL = 'http://localhost:10000/api';
const ADMIN_EMAIL = 'rcmaiasistant@gmail.com';
const ADMIN_PASSWORD = 'Titan@123'; // Reset password

const loginAdmin = async () => {
    try {
        const response = await axios.post(`${BASE_URL}/auth/admin/login`, {
            loginId: ADMIN_EMAIL,
            password: ADMIN_PASSWORD
        });
        console.log("Admin Login Response:", response.data);
        return response.data.accessToken;
    } catch (error) {
        console.error("Error logging in admin:", error.message);
        return null;
    }
};

const sendNotificationTest = async (accessToken) => {
    try {
        const notificationPayload = {
            title: "Test Notification",
            body: "This is a test notification from the API.",
            dataPayload: { key: "value", type: "test" }
        };

        const response = await axios.post(`${BASE_URL}/notifications/send`, notificationPayload, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        console.log("Send Notification Response:", response.data);
        if (response.data.success) {
            console.log("✅ Notification sent successfully.");
            return true;
        } else {
            console.log("❌ Failed to send notification.");
            return false;
        }
    } catch (error) {
        console.error("Error sending notification:", error.message);
        return false;
    }
};

const runTests = async () => {
    console.log("Starting notification tests...");

    // Test health endpoint (already confirmed working, but keep for completeness)
    try {
        const healthResponse = await axios.get(`${BASE_URL}/notifications/test-health`);
        console.log("Notification Test Health Response:", healthResponse.data);
        if (healthResponse.data.status === 'active') {
            console.log("✅ Notification Test Health endpoint is active.");
        } else {
            console.log("❌ Notification Test Health endpoint is not active.");
        }
    } catch (error) {
        console.error("Error testing Notification Test Health endpoint:", error.message);
    }

    const accessToken = await loginAdmin();
    if (accessToken) {
        await sendNotificationTest(accessToken);
    } else {
        console.log("Skipping notification send test due to login failure.");
    }

    console.log("Notification tests finished.");
};

runTests();