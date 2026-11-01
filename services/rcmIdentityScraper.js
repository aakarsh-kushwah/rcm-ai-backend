'use strict';

const { RcmIdentity } = require('../models');

function getNestedValue(obj, keys) {
  for (const key of keys) {
    let current = obj;
    const parts = key.split('.');
    let found = true;

    for (const part of parts) {
      if (!current || !Object.prototype.hasOwnProperty.call(current, part)) {
        found = false;
        break;
      }
      current = current[part];
    }

    if (found && current !== undefined && current !== null && current !== '') {
      return current;
    }
  }

  return undefined;
}

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeAddress(value) {
  const raw = normalizeString(value);
  return raw || null;
}

function extractPhone(value) {
  if (!value) return null;
  const phone = String(value).replace(/[^0-9+]/g, '').replace(/^\+?/, '');
  return phone || null;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function buildIdentityRecord(profileData, buyerIdNumber) {
  const buyerId = Number(pickFirst(
    getNestedValue(profileData, ['dist_no', 'distNo', 'buyer_id', 'buyerId', 'member_id']),
    buyerIdNumber
  )) || buyerIdNumber;

  const record = {
    buyer_id: buyerId,
    name: normalizeString(
      pickFirst(
        getNestedValue(profileData, ['dist_name', 'name', 'full_name', 'customer_name', 'member_name']),
        'Unknown Buyer'
      )
    ),
    mobile_no: extractPhone(
      pickFirst(
        getNestedValue(profileData, ['mobile_no', 'phone', 'contact_number', 'mobile', 'communication_details.mobile', 'communication_details.phone']),
        getNestedValue(profileData, ['primary_mobile', 'dist_mobile'])
      )
    ),
    phone: null,
    state: normalizeString(
      pickFirst(
        getNestedValue(profileData, ['state', 'state_name', 'dist_state', 'address_state', 'communication_details.state']),
        getNestedValue(profileData, ['address.state'])
      )
    ) || null,
    district: normalizeString(
      pickFirst(
        getNestedValue(profileData, ['district', 'dist_district', 'city_district', 'address_district', 'communication_details.district']),
        getNestedValue(profileData, ['address.district'])
      )
    ) || null,
    city: normalizeString(
      pickFirst(
        getNestedValue(profileData, ['city', 'dist_city', 'address_city', 'communication_details.city']),
        getNestedValue(profileData, ['address.city'])
      )
    ) || null,
    post_village: normalizeString(
      pickFirst(
        getNestedValue(profileData, ['post_village', 'village', 'post', 'address_post', 'communication_details.post_village']),
        getNestedValue(profileData, ['address.post_village'])
      )
    ) || null,
    pincode: normalizeString(
      pickFirst(
        getNestedValue(profileData, ['pincode', 'pin_code', 'postcode', 'postal_code', 'communication_details.pincode']),
        getNestedValue(profileData, ['address.pincode'])
      )
    ) || null,
    address: normalizeAddress(
      pickFirst(
        getNestedValue(profileData, ['full_address', 'address', 'communication_details.address', 'communication_details.full_address']),
        [
          [
            normalizeString(getNestedValue(profileData, ['address_line_1'])),
            normalizeString(getNestedValue(profileData, ['address_line_2']))
          ].filter(Boolean).join(', '),
          [
            normalizeString(getNestedValue(profileData, ['city'])),
            normalizeString(getNestedValue(profileData, ['district'])),
            normalizeString(getNestedValue(profileData, ['state'])),
            normalizeString(getNestedValue(profileData, ['pincode']))
          ].filter(Boolean).join(', ')
        ].find(Boolean)
      )
    ),
    highest_pin: typeof profileData?.highest_pin === 'object'
      ? (profileData.highest_pin?.pin_name || profileData.highest_pin?.name || 'DIRECT SELLER')
      : String(profileData?.highest_pin || 'DIRECT SELLER'),
    join_date: normalizeDate(
      pickFirst(
        getNestedValue(profileData, ['join_date', 'joining_date', 'date_of_joining', 'created_at', 'createdOn']),
        getNestedValue(profileData, ['profile.join_date'])
      )
    ),
    kyc_status: normalizeString(
      pickFirst(
        getNestedValue(profileData, ['kyc_status', 'status', 'kycStatus', 'verification_status']),
        'KYC OK'
      )
    ) || 'KYC OK',
    profile_photo_url: (() => {
      const img = profileData?.dist_image || profileData?.profile_photo_url || profileData?.image || profileData?.avatar;
      if (!img) return null;
      const doc = typeof img === 'string' ? img : (img?.doc_path || img?.path || '');
      if (!doc) return null;
      return doc.startsWith('http') ? doc : `https://ecomapi.rcmworld.com${doc.startsWith('/') ? '' : '/'}${doc}`;
    })(),
    // Lineage is no longer stored in DownlineNode, so it's also removed from RcmIdentity record if not directly provided.
    lineage: normalizeString(getNestedValue(profileData, ['lineage']) || ''),
    network_summary: null,
    updated_at: new Date(),
    created_at: new Date(),
  };

  return record;
}

async function scrapeIdentityCard(session, buyerId) {
  if (!session || typeof session.get !== 'function') {
    throw new Error('A valid RCM session is required to scrape the identity card.');
  }

  const buyerIdNumber = Number(buyerId);
  if (!Number.isFinite(buyerIdNumber) || buyerIdNumber <= 0) {
    throw new Error('A valid buyer ID is required to scrape the identity card.');
  }

  const response = await session.get('https://ecomapi.rcmworld.com/api/user/profile/get-personal-info', {
    headers: {
      resource: 'web',
      Origin: 'https://rcmworld.com',
      Referer: 'https://www.rcmworld.com/',
      pincode: '834001',
      language: 'EN',
      'area-name': '',
    },
    responseType: 'json',
  });

  if (!response || response.status !== 200) {
    throw new Error('Unable to load the RCM identity card data.');
  }

  const payload = response.data && response.data.data ? response.data.data : response.data;
  const profileData = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

  const identity = buildIdentityRecord(profileData, buyerIdNumber);

  if (!identity.name || identity.name.length < 2) {
    throw new Error('Unable to determine the buyer name from the official RCM profile response.');
  }

  await RcmIdentity.upsert(identity, {
    fields: [
      'name',
      'mobile_no',
      'phone',
      'address',
      'state',
      'district',
      'city',
      'post_village',
      'pincode',
      'highest_pin',
      'join_date',
      'kyc_status',
      'profile_photo_url',
      'lineage',
      'network_summary',
      'updated_at'
    ],
  });

  return {
    buyer_id: identity.buyer_id,
    name: identity.name,
    mobile_no: identity.mobile_no,
    state: identity.state,
    district: identity.district,
    city: identity.city,
    post_village: identity.post_village,
    pincode: identity.pincode,
    highest_pin: identity.highest_pin,
    profile_photo_url: identity.profile_photo_url,
    address: identity.address,
    join_date: identity.join_date,
    kyc_status: identity.kyc_status,
  };
}

module.exports = {
  scrapeIdentityCard,
};
