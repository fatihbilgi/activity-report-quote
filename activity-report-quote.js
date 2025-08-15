const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek');
require('dotenv').config();

axiosRetry(axios, {
    retries: 5,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        const status = error.response?.status;
        return status === 503 || status === 429 || error.code === 'ECONNABORTED';
    }
});

async function fetchDeals() {
    const deals = [];
    let start = 0;

    dayjs.extend(isoWeek);
    //const lastWeekStart = dayjs().subtract(1, 'week').startOf('isoWeek').format('YYYY-MM-DDTHH:mm:ss');
    //const lastWeekEnd = dayjs().subtract(1, 'week').endOf('isoWeek').format('YYYY-MM-DDTHH:mm:ss');

    const startDate = dayjs().subtract(7, 'day').startOf('day').format('YYYY-MM-DDTHH:mm:ss');
    const endDate = dayjs().subtract(1, 'day').endOf('day').format('YYYY-MM-DDTHH:mm:ss');

    console.log(startDate);
    console.log(endDate);

    while (true) {
        const response = await axios.get(`${process.env.BITRIX_URL}/crm.deal.list`, {
            params: {
                filter: {
                    //"ID": 160471,
                    "STAGE_ID": ["1"],
                    ">=DATE_CREATE": startDate,
                    "<=DATE_CREATE": endDate
                },
                order: { "DATE_CREATE": "DESC" },
                start: start
            }
        });

        const result = response.data.result;
        if (!result.length) break;

        deals.push(...result);
        if (response.data.next !== undefined) {
            start = response.data.next;
        } else {
            break;
        }
    }

    console.log(`Fetched ${deals.length} deals created in the last week.`);
    return deals;
}

async function fetchDealById(dealId) {
    try {
        const response = await axios.get(`${process.env.BITRIX_URL}/crm.deal.get`, {
            params: {
                id: dealId
            }
        });

        return response.data.result;
    } catch (error) {
        console.error(`Deal ID ${dealId} için veri alınamadı:`, error.message);
        return null;
    }
}

async function fetchActivities(dealId, quoteDate) {
    let start = 0;
    const activities = [];

    while (activities.length < 3) {
        const response = await axios.get(`${process.env.BITRIX_URL}/crm.activity.list`, {
            params: {
                filter: {
                    "OWNER_ID": dealId,
                    "OWNER_TYPE_ID": 2,
                    "COMPLETED": "Y",
                    "PROVIDER_ID": "CRM_TODO",
                    ">CREATED": quoteDate
                },
                order: { "LAST_UPDATED": "ASC" },
                start: start
            }
        });

        const result = response.data.result;
        if (!result || result.length === 0) break;

        activities.push(...result);

        if (response.data.next !== undefined) {
            start = response.data.next;
        } else {
            break;
        }
    }

    // const ordered = activities
    //     .filter(a => a.LAST_UPDATED)
    //     .filter(a => new Date(a.LAST_UPDATED) > new Date(quoteDate))
    //     .sort((a, b) => new Date(a.LAST_UPDATED) - new Date(b.LAST_UPDATED));

    return activities.slice(0, 3);
}

async function batchUpdateDeals(updates) {
    const batchSize = 50;
    for (let i = 0; i < updates.length; i += batchSize) {
        const chunk = updates.slice(i, i + batchSize);
        const cmd = {};

        chunk.forEach((u, index) => {
            cmd[`update${index}`] = `crm.deal.update?ID=${u.id}&FIELDS[UF_CRM_1747742892]=${u.first}&FIELDS[UF_CRM_1747761003]=${u.second ?? ''}&FIELDS[UF_CRM_1747761025]=${u.third ?? ''}`;
        });

        try {
            await axios.post(`${process.env.BITRIX_URL}/batch`, {
                cmd
            });
            console.log(`Batch ${i / batchSize + 1} sent successfully.`);
        } catch (error) {
            console.error(`Batch update failed:`, error.response?.data || error.message);
        }

        // Delay between batches to avoid rate limits
        await new Promise(res => setTimeout(res, 1000));
    }
}

async function calculateResponseTimes() {
    const deals = await fetchDeals();
    const updates = [];
    let dealsWithActivity = 0;

    for (const deal of deals) {
        const detailDeal = await fetchDealById(deal.ID);
        const quoteTime = detailDeal.UF_CRM_1710157689
        const activities = await fetchActivities(deal.ID, quoteTime);

        if (activities.length > 0) {
            dealsWithActivity++;
            const first = dayjs(activities[0].LAST_UPDATED).diff(quoteTime, 'minute');
            const second = activities[1]?.LAST_UPDATED
                ? dayjs(activities[1].LAST_UPDATED).diff(dayjs(activities[0].LAST_UPDATED), 'minute')
                : null;
            const third = activities[2]?.LAST_UPDATED
                ? dayjs(activities[2].LAST_UPDATED).diff(dayjs(activities[1].LAST_UPDATED), 'minute')
                : null;

            updates.push({
                id: deal.ID,
                first,
                second,
                third
            });
        }
    }

    console.log(`Deals with at least one activity: ${dealsWithActivity}`);
    console.log(`Total deals fetched: ${deals.length}`);

    await batchUpdateDeals(updates);
    console.log(`${updates.length} follow up times batched and updated.`);
}


calculateResponseTimes();
