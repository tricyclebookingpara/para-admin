// Adds three SAMPLE pending driver applications (with sample documents) so
// Driver Verification has something to show. Paste this whole file into the
// browser console on the admin site while you are logged in, then run:
//
//     await addSampleDrivers()      // add them
//     await removeSampleDrivers()   // delete them again
//
// The images are the SVG files in this folder (fictional people, marked SAMPLE).
// The records are written as the admin (the Firestore rules allow it); the ids
// start with SEED_DRV_ so they are easy to find and remove.

(function () {
    const db = firebase.firestore();
    const IDS = ['SEED_DRV_01', 'SEED_DRV_02', 'SEED_DRV_03'];
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
    const img = (name) => `samples/${name}.svg`;

    const drivers = () => [
        {
            id: IDS[0], fullName: 'Rodel Manalo', email: 'sample.rodel@example.com', phoneNumber: '09170000101',
            licenseNumber: 'N02-24-558201', licenseExpiryDate: '20/06/2029', governmentId: '4821-7730-5519-0284',
            tricycleNumber: 'TC-0142', plateNumber: 'ABC 1234', motorcycleModel: 'Honda TMX 155',
            vehicleRegistrationDate: '12/01/2026', todaName: 'Hagonoy TODA',
            profilePhotoStatus: 'pending', n: 1, withPermit: true, hoursAgo: 3
        },
        {
            id: IDS[1], fullName: 'Arnel Villanueva', email: 'sample.arnel@example.com', phoneNumber: '09170000102',
            licenseNumber: 'N03-21-771934', licenseExpiryDate: fmt(inDays(20)), governmentId: '7305-1184-6620-9951',
            tricycleNumber: 'TC-0287', plateNumber: 'XYZ 5678', motorcycleModel: 'Kawasaki Barako 175',
            vehicleRegistrationDate: '05/03/2026', todaName: 'San Agustin TODA',
            profilePhotoStatus: 'approved', n: 2, withPermit: true, hoursAgo: 26
        },
        {
            id: IDS[2], fullName: 'Jessa Dimaculangan', email: 'sample.jessa@example.com', phoneNumber: '09170000103',
            licenseNumber: 'N01-23-209477', licenseExpiryDate: '09/12/2030', governmentId: '2236-9041-3378-5502',
            tricycleNumber: 'TC-0391', plateNumber: 'JKL 9012', motorcycleModel: 'Yamaha YTX 125',
            vehicleRegistrationDate: '19/02/2026', todaName: 'Hagonoy TODA',
            profilePhotoStatus: 'pending', n: 3, withPermit: false, hoursAgo: 50
        }
    ];

    window.addSampleDrivers = async function () {
        for (const d of drivers()) {
            const { id, n, withPermit, hoursAgo, ...fields } = d;
            await db.collection('users').doc(id).set({
                ...fields,
                role: 'DRIVER',
                verificationStatus: 'pending',
                isVerified: false,
                accountStatus: 'active',
                isSuspended: false,
                driverStatus: 'OFFLINE',
                createdAt: firebase.firestore.Timestamp.fromMillis(Date.now() - hoursAgo * 3600 * 1000),
                profileImage: img(`profile-${n}`),
                governmentIdImageUrl: img(`gov-id-${n}`),
                licenseImageUrl: img(`license-${n}`),
                vehicleRegistrationImageUrl: img(`or-cr-${n}`),
                tricyclePermitImageUrl: withPermit ? img(`permit-${n}`) : '',
                tricycleImageUrl: img(`tricycle-${n}`)
            });
        }
        console.log('Added 3 sample drivers. Open Driver Verification.');
    };

    window.removeSampleDrivers = async function () {
        for (const id of IDS) await db.collection('users').doc(id).delete();
        console.log('Removed the sample drivers.');
    };

    console.log('Ready: run  await addSampleDrivers()  or  await removeSampleDrivers()');
})();
