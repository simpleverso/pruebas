function Cargarmyubiacion()
{
    let latText = document.getElementById("latitude");
    let longText = document.getElementById("longitude");
    
        navigator.geolocation.getCurrentPosition(function (position) 
        {
            let lat = position.coords.latitude;
            let long = position.coords.longitude;

            latText.innerText = lat.toFixed(5);
            longText.innerText = long.toFixed(5);
        });
}
