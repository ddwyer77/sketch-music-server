import { db, FieldValue } from '../firebaseAdmin.js';

async function migrateUserRoles() {
    const userRef = db.collection('users');
    const snapshot = await userRef.get();

    let updated = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.user_type && !data.roles) {
                const newRoles = [data.user_type]; // use underscore, not camelCase!
                await doc.ref.update({
                    roles: newRoles,
                    user_type: FieldValue.delete(),
                });
                updated++;
                console.log(`Updated user ${doc.id}: roles = [${data.user_type}]`);
            }
        }
        console.log(`\nDone! Updated ${updated} users.`);
}

migrateUserRoles()
    .catch(err => {
        console.error('Error updating user roles:', err);
        process.exit(1);
    });
